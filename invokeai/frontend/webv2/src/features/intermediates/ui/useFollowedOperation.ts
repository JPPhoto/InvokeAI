import type { IntermediatesOperation } from '@features/intermediates/core/types';
import type { AccountScope } from '@platform/state/accountLifecycle';
import type { RefObject } from 'react';

import {
  getIntermediatesOperation,
  retryIntermediatesOperation,
  startIntermediatesOperation,
} from '@features/intermediates/data/api';
import { intermediatesKeys } from '@features/intermediates/data/keys';
import {
  activeOperationStore,
  clearPendingIntermediatesStart,
  followIntermediatesOperation,
  isPendingIntermediatesStartCurrent,
  restoreIntermediatesReceipt,
} from '@features/intermediates/data/operationStore';
import { intermediatesOperationQueryOptions } from '@features/intermediates/data/queries';
import { attachIntermediatesRealtime } from '@features/intermediates/data/realtime';
import { useMountEffect } from '@platform/react/useMountEffect';
import {
  assertAccountScopeCurrent,
  captureAccountScope,
  isAccountScopeCurrent,
} from '@platform/state/accountLifecycle';
import { getApiErrorMessage } from '@platform/transport/http';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

const getLatestRetry = async (operationId: string, signal: AbortSignal): Promise<IntermediatesOperation> => {
  let operation = await getIntermediatesOperation(operationId, signal);
  const visited = new Set<string>([operationId]);
  while (operation.retriedByOperationId && !visited.has(operation.retriedByOperationId)) {
    visited.add(operation.retriedByOperationId);
    operation = await getIntermediatesOperation(operation.retriedByOperationId, signal);
  }
  return operation;
};

/**
 * The operation the section follows, kept across visits. On mount it attaches realtime updates, replays a Confirm
 * whose response was lost, and otherwise catches up with a retry started elsewhere.
 */
export const useFollowedOperation = ({ fallbackFocusRef }: { fallbackFocusRef: RefObject<HTMLElement | null> }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const operationId = activeOperationStore.useSelector((snapshot) => snapshot.operationId);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const query = useQuery({ ...intermediatesOperationQueryOptions(operationId ?? ''), enabled: operationId !== null });

  const follow = useCallback(
    (owner: AccountScope, operation: IntermediatesOperation) => {
      queryClient.setQueryData(intermediatesKeys.operation(owner, operation.operationId), operation);
      followIntermediatesOperation(operation.operationId);
    },
    [queryClient]
  );

  useMountEffect(() => {
    let mounted = true;
    const detach = attachIntermediatesRealtime(queryClient);
    const owner = captureAccountScope();
    const pending = restoreIntermediatesReceipt();
    if (pending) {
      void startIntermediatesOperation(pending, owner.signal)
        .then((operation) => {
          if (isAccountScopeCurrent(owner) && isPendingIntermediatesStartCurrent(pending)) {
            follow(owner, operation);
          }
        })
        .catch((error: unknown) => {
          if (isPendingIntermediatesStartCurrent(pending, owner)) {
            clearPendingIntermediatesStart(owner);
            if (mounted && isAccountScopeCurrent(owner)) {
              setRecoveryError(getApiErrorMessage(error, t('intermediates.dialog.startFailed')));
            }
          }
        });
    } else {
      const followed = activeOperationStore.getSnapshot().operationId;
      if (followed) {
        void getLatestRetry(followed, owner.signal)
          .then((operation) => {
            if (
              isAccountScopeCurrent(owner) &&
              activeOperationStore.getSnapshot().operationId === followed &&
              operation.operationId !== followed
            ) {
              follow(owner, operation);
            }
          })
          .catch(() => undefined); // The operation query reports lookup failures in the panel.
      }
    }
    return () => {
      mounted = false;
      detach();
    };
  });

  const retry = useCallback(async () => {
    if (!operationId) {
      return;
    }
    const owner = captureAccountScope();
    setIsRetrying(true);
    setRetryError(null);
    try {
      const operation = await retryIntermediatesOperation(operationId, owner.signal);
      assertAccountScopeCurrent(owner);
      follow(owner, operation);
    } catch (error) {
      if (isAccountScopeCurrent(owner)) {
        try {
          const latest = await getLatestRetry(operationId, owner.signal);
          if (
            latest.operationId !== operationId &&
            isAccountScopeCurrent(owner) &&
            activeOperationStore.getSnapshot().operationId === operationId
          ) {
            follow(owner, latest);
            return;
          }
        } catch {
          // Preserve the original retry error when reconciliation is unavailable.
        }
        setRetryError(getApiErrorMessage(error, t('intermediates.operation.retryFailed')));
      }
    } finally {
      if (isAccountScopeCurrent(owner)) {
        setIsRetrying(false);
      }
    }
  }, [follow, operationId, t]);
  const dismiss = useCallback(() => {
    followIntermediatesOperation(null);
    setRetryError(null);
    // The Dismiss button unmounts with the panel; keep keyboard focus in the section.
    fallbackFocusRef.current?.focus();
  }, [fallbackFocusRef]);
  const clearRetryError = useCallback(() => setRetryError(null), []);

  return { clearRetryError, dismiss, isRetrying, operationId, query, recoveryError, retry, retryError };
};
