import type { RefObject } from 'react';

import { retryIntermediatesOperation } from '@features/intermediates/data/api';
import {
  activeOperationStore,
  adoptIntermediatesOperation,
  attachIntermediatesManager,
  findLatestIntermediatesRetry,
  followIntermediatesOperation,
} from '@features/intermediates/data/operationStore';
import { intermediatesOperationQueryOptions } from '@features/intermediates/data/queries';
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

/** The operation the section follows, kept across visits by the operation store, which this hook subscribes to. */
export const useFollowedOperation = ({ fallbackFocusRef }: { fallbackFocusRef: RefObject<HTMLElement | null> }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const operationId = activeOperationStore.useSelector((snapshot) => snapshot.operationId);
  const recoveryError = activeOperationStore.useSelector((snapshot) => snapshot.recoveryError);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const query = useQuery({ ...intermediatesOperationQueryOptions(operationId ?? ''), enabled: operationId !== null });

  useMountEffect(() => attachIntermediatesManager(queryClient));

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
      adoptIntermediatesOperation(queryClient, owner, operation);
    } catch (error) {
      if (isAccountScopeCurrent(owner)) {
        try {
          const latest = await findLatestIntermediatesRetry(operationId, owner.signal);
          if (
            latest.operationId !== operationId &&
            isAccountScopeCurrent(owner) &&
            activeOperationStore.getSnapshot().operationId === operationId
          ) {
            adoptIntermediatesOperation(queryClient, owner, latest);
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
  }, [operationId, queryClient, t]);
  const dismiss = useCallback(() => {
    followIntermediatesOperation(null);
    setRetryError(null);
    // The Dismiss button unmounts with the panel; keep keyboard focus in the section.
    fallbackFocusRef.current?.focus();
  }, [fallbackFocusRef]);
  const clearRetryError = useCallback(() => setRetryError(null), []);

  return {
    clearRetryError,
    dismiss,
    isRetrying,
    operationId,
    query,
    recoveryError: recoveryError ? getApiErrorMessage(recoveryError, t('intermediates.dialog.startFailed')) : null,
    retry,
    retryError,
  };
};
