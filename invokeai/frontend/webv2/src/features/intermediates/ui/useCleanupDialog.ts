import type { IntermediatesScopeRequest } from '@features/intermediates/core/selection';
import type { IntermediatesCleanupMode, IntermediatesScope } from '@features/intermediates/core/types';
import type { IntermediatesSummaryParams } from '@features/intermediates/data/keys';

import { resolveMatchingTargets } from '@features/intermediates/core/selection';
import {
  createIntermediatesPreview,
  getIntermediatesSummary,
  startIntermediatesOperation,
} from '@features/intermediates/data/api';
import {
  adoptIntermediatesOperation,
  clearPendingIntermediatesStart,
  recordPendingIntermediatesStart,
} from '@features/intermediates/data/operationStore';
import { INTERMEDIATES_MAX_ROWS } from '@features/intermediates/data/queries';
import { createUuid } from '@platform/browser/randomUuid';
import {
  assertAccountScopeCurrent,
  captureAccountScope,
  isAccountScopeCurrent,
  type AccountScope,
} from '@platform/state/accountLifecycle';
import { ApiError, getApiErrorMessage } from '@platform/transport/http';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ClearDialogState } from './ClearDialog';

interface DialogRequest {
  scope: IntermediatesScopeRequest;
  /** The filters the request was made under; a `matching` scope resolves against them. */
  params: IntermediatesSummaryParams;
}

/** The confirmation flow: preview a scope, optionally switch to force, and start the operation it froze. */
export const useCleanupDialog = ({ onStarted }: { onStarted: () => void }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<ClearDialogState | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const startedRef = useRef(false);
  const requestRef = useRef(0);
  const dialogRequestRef = useRef<DialogRequest | null>(null);

  const resolveScope = useCallback(
    async ({ params, scope }: DialogRequest, owner: AccountScope): Promise<IntermediatesScope> => {
      if (scope.kind !== 'matching') {
        return scope;
      }
      const matching = await getIntermediatesSummary(
        { ...params, limit: INTERMEDIATES_MAX_ROWS, offset: 0 },
        owner.signal
      );
      assertAccountScopeCurrent(owner);
      if (matching.total > matching.items.length) {
        throw new Error(t('intermediates.dialog.tooManyRows', { count: matching.items.length }));
      }
      return { kind: 'selection', targets: resolveMatchingTargets(scope.excluded, matching.items) };
    },
    [t]
  );

  const loadPreview = useCallback(
    async (mode: IntermediatesCleanupMode, request: DialogRequest) => {
      const requestId = ++requestRef.current;
      const owner = captureAccountScope();
      setDialog((current) => ({
        idempotencyKey: current?.idempotencyKey ?? createUuid(),
        isStarting: false,
        mode,
        preview: null,
        previewError: null,
        startError: null,
      }));
      try {
        const scope = await resolveScope(request, owner);
        const preview = await createIntermediatesPreview({ mode, scope }, owner.signal);
        assertAccountScopeCurrent(owner);
        if (requestRef.current === requestId) {
          // One key per preview: every Confirm of this preview replays the same operation, and a later preview
          // (mode switch, retry) starts clean instead of colliding with a key the server already settled.
          setDialog((current) => (current ? { ...current, idempotencyKey: createUuid(), preview } : current));
        }
      } catch (error) {
        if (requestRef.current === requestId && isAccountScopeCurrent(owner)) {
          setDialog((current) =>
            current
              ? { ...current, previewError: getApiErrorMessage(error, t('intermediates.dialog.previewFailed')) }
              : current
          );
        }
      }
    },
    [resolveScope, t]
  );

  const open = useCallback(
    (scope: IntermediatesScopeRequest, params: IntermediatesSummaryParams, trigger: HTMLElement | null) => {
      triggerRef.current = trigger;
      startedRef.current = false;
      dialogRequestRef.current = { params, scope };
      setDialog(null);
      void loadPreview('safe', dialogRequestRef.current);
    },
    [loadPreview]
  );
  // A timed-out start keeps its receipt: the server may have accepted it, and the next visit replays the same key.
  const close = useCallback(() => {
    requestRef.current += 1;
    setDialog(null);
  }, []);
  const retryPreview = useCallback(() => {
    if (dialog && dialogRequestRef.current) {
      void loadPreview(dialog.mode, dialogRequestRef.current);
    }
  }, [dialog, loadPreview]);
  const changeMode = useCallback(
    (mode: IntermediatesCleanupMode) => {
      if (dialogRequestRef.current) {
        void loadPreview(mode, dialogRequestRef.current);
      }
    },
    [loadPreview]
  );
  const confirm = useCallback(async () => {
    const preview = dialog?.preview ?? null;
    if (!dialog || !preview) {
      return;
    }
    const owner = captureAccountScope();
    const start = { idempotencyKey: dialog.idempotencyKey, previewId: preview.previewId };
    recordPendingIntermediatesStart(start);
    setDialog((current) => (current ? { ...current, isStarting: true, startError: null } : current));
    try {
      const operation = await startIntermediatesOperation(start, owner.signal);
      assertAccountScopeCurrent(owner);
      adoptIntermediatesOperation(queryClient, owner, operation);
      startedRef.current = true;
      onStarted();
      setDialog(null);
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
      // Any other outcome settles this start; nothing may replay it, including after signing back in.
      if (!timedOut) {
        clearPendingIntermediatesStart(owner);
      }
      if (!isAccountScopeCurrent(owner) || (error instanceof DOMException && error.name === 'AbortError')) {
        setDialog((current) => (current ? { ...current, isStarting: false } : current));
        return;
      }
      // A 404 means the preview expired or was consumed by a request whose response was lost; only a new
      // preview can move forward, so offer that instead of a dead Confirm.
      const previewGone = error instanceof ApiError && error.status === 404;
      setDialog((current) =>
        current
          ? {
              ...current,
              isStarting: false,
              preview: previewGone ? null : current.preview,
              previewError: previewGone ? t('intermediates.dialog.previewExpired') : current.previewError,
              startError: previewGone
                ? null
                : timedOut
                  ? t('intermediates.dialog.startTimedOut', {
                      action: t(
                        current.mode === 'force' ? 'intermediates.dialog.forceConfirm' : 'intermediates.dialog.confirm'
                      ),
                    })
                  : getApiErrorMessage(error, t('intermediates.dialog.startFailed')),
            }
          : current
      );
    }
  }, [dialog, onStarted, queryClient, t]);

  const hasStarted = useCallback(() => startedRef.current, []);

  return { changeMode, close, confirm, hasStarted, open, retryPreview, state: dialog, triggerRef };
};
