import type { IntermediatesSelection } from '@features/intermediates/core/selection';
import type { IntermediatesCleanupMode, IntermediatesScope } from '@features/intermediates/core/types';
import type { IntermediatesSummaryParams } from '@features/intermediates/data/keys';

import { isRowSelected } from '@features/intermediates/core/selection';
import {
  createIntermediatesPreview,
  getIntermediatesSummary,
  startIntermediatesOperation,
} from '@features/intermediates/data/api';
import { intermediatesKeys } from '@features/intermediates/data/keys';
import {
  clearPendingIntermediatesStart,
  followIntermediatesOperation,
  recordPendingIntermediatesStart,
} from '@features/intermediates/data/operationStore';
import { INTERMEDIATES_MAX_ROWS } from '@features/intermediates/data/queries';
import {
  assertAccountScopeCurrent,
  captureAccountScope,
  isAccountScopeCurrent,
} from '@platform/state/accountLifecycle';
import { ApiError, getApiErrorMessage } from '@platform/transport/http';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ClearDialogState } from './ClearDialog';

let nextIdempotencyKey = 1;
const createIdempotencyKey = (): string => `intermediates:${Date.now().toString(36)}:${nextIdempotencyKey++}`;

/** The confirmation flow: preview a scope, optionally switch to force, and start the operation it froze. */
export const useCleanupDialog = ({
  onStarted,
  params,
  selection,
}: {
  onStarted: () => void;
  params: IntermediatesSummaryParams;
  selection: IntermediatesSelection;
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<ClearDialogState | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const requestRef = useRef(0);
  const scopeRef = useRef<IntermediatesScope | null>(null);

  const loadPreview = useCallback(
    async (mode: IntermediatesCleanupMode, scope: IntermediatesScope) => {
      const requestId = ++requestRef.current;
      const owner = captureAccountScope();
      setDialog((current) => ({
        idempotencyKey: current?.idempotencyKey ?? createIdempotencyKey(),
        isStarting: false,
        mode,
        preview: null,
        previewError: null,
        startError: null,
      }));
      try {
        let resolvedScope = scope;
        // Filters and exclusions cannot be expressed by the cleanup scope; resolve them to explicit rows.
        if (selection.mode === 'all-matching' && scope.kind === 'selection') {
          const everything = await getIntermediatesSummary(
            { ...params, limit: INTERMEDIATES_MAX_ROWS, offset: 0 },
            owner.signal
          );
          assertAccountScopeCurrent(owner);
          if (everything.total > everything.items.length) {
            throw new Error(t('intermediates.dialog.tooManyRows', { count: everything.items.length }));
          }
          resolvedScope = {
            kind: 'selection',
            targets: everything.items
              .filter((row) => isRowSelected(selection, row))
              .map(({ projectId, userId }) => ({ projectId, userId })),
          };
        }
        const preview = await createIntermediatesPreview({ mode, scope: resolvedScope }, owner.signal);
        assertAccountScopeCurrent(owner);
        if (requestRef.current === requestId) {
          // One key per preview: every Confirm of this preview replays the same operation, and a later preview
          // (mode switch, retry) starts clean instead of colliding with a key the server already settled.
          setDialog((current) => (current ? { ...current, idempotencyKey: createIdempotencyKey(), preview } : current));
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
    [params, selection, t]
  );

  const open = useCallback(
    (scope: IntermediatesScope, trigger: HTMLElement | null) => {
      triggerRef.current = trigger;
      scopeRef.current = scope;
      setDialog(null);
      void loadPreview('safe', scope);
    },
    [loadPreview]
  );
  const close = useCallback(() => {
    requestRef.current += 1;
    // Walking away from a failed start must not let a later visit replay it.
    clearPendingIntermediatesStart();
    setDialog(null);
  }, []);
  const retryPreview = useCallback(() => {
    if (dialog && scopeRef.current) {
      void loadPreview(dialog.mode, scopeRef.current);
    }
  }, [dialog, loadPreview]);
  const changeMode = useCallback(
    (mode: IntermediatesCleanupMode) => {
      if (scopeRef.current) {
        void loadPreview(mode, scopeRef.current);
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
      queryClient.setQueryData(intermediatesKeys.operation(owner, operation.operationId), operation);
      followIntermediatesOperation(operation.operationId);
      onStarted();
      setDialog(null);
    } catch (error) {
      // Whatever settled it, this start is over; nothing may replay it, including after signing back in.
      clearPendingIntermediatesStart(owner);
      if (!isAccountScopeCurrent(owner) || (error instanceof DOMException && error.name === 'AbortError')) {
        setDialog((current) => (current ? { ...current, isStarting: false } : current));
        return;
      }
      // A 404 means the preview expired or was consumed by a request whose response was lost; only a new
      // preview can move forward, so offer that instead of a dead Confirm.
      const previewGone = error instanceof ApiError && error.status === 404;
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
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
                  ? t('intermediates.dialog.startTimedOut')
                  : getApiErrorMessage(error, t('intermediates.dialog.startFailed')),
            }
          : current
      );
    }
  }, [dialog, onStarted, queryClient, t]);

  return { changeMode, close, confirm, open, retryPreview, state: dialog, triggerRef };
};
