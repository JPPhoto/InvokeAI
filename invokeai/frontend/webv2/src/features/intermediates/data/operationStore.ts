import { captureAccountScope, registerAccountOwnedResource } from '@platform/state/accountLifecycle';
import { createExternalStore } from '@platform/state/externalStore';

/**
 * The operation the manager is following. Kept outside the component so closing Settings while a cleanup runs and
 * reopening it later shows the same operation, its result and its retry affordance.
 */
export const activeOperationStore = createExternalStore<{ operationId: string | null }>({ operationId: null });

interface PendingStart {
  previewId: string;
  idempotencyKey: string;
}

const receiptKey = (): string => {
  const owner = captureAccountScope();
  return `invokeai:webv2:intermediates-receipt:${owner.accountId ?? 'local'}${owner.storageSuffix}`;
};

const readReceipt = (): { operationId?: string; pendingStart?: PendingStart } => {
  try {
    return JSON.parse(sessionStorage.getItem(receiptKey()) ?? '{}') as {
      operationId?: string;
      pendingStart?: PendingStart;
    };
  } catch {
    return {};
  }
};

const writeReceipt = (receipt: { operationId?: string; pendingStart?: PendingStart }): void => {
  try {
    if (!receipt.operationId && !receipt.pendingStart) {
      sessionStorage.removeItem(receiptKey());
    } else {
      sessionStorage.setItem(receiptKey(), JSON.stringify(receipt));
    }
  } catch {
    // A private-mode storage failure still leaves the in-memory operation visible this session.
  }
};

export const restoreIntermediatesReceipt = (): PendingStart | null => {
  const receipt = readReceipt();
  if (typeof receipt.operationId === 'string' && receipt.operationId.length > 0) {
    activeOperationStore.setSnapshot({ operationId: receipt.operationId });
  }
  return receipt.pendingStart ?? null;
};

export const recordPendingIntermediatesStart = (pendingStart: PendingStart): void => {
  writeReceipt({ ...readReceipt(), pendingStart });
};

export const isPendingIntermediatesStartCurrent = (pendingStart: PendingStart): boolean => {
  const current = readReceipt().pendingStart;
  return current?.previewId === pendingStart.previewId && current.idempotencyKey === pendingStart.idempotencyKey;
};

export const clearPendingIntermediatesStart = (): void => {
  const { operationId } = readReceipt();
  writeReceipt({ operationId });
};

registerAccountOwnedResource({
  clear: () => activeOperationStore.setSnapshot({ operationId: null }),
  name: 'intermediates-active-operation',
});

export const followIntermediatesOperation = (operationId: string | null): void => {
  activeOperationStore.setSnapshot({ operationId });
  writeReceipt({ operationId: operationId ?? undefined });
};
