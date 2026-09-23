import { captureAccountScope, registerAccountOwnedResource, type AccountScope } from '@platform/state/accountLifecycle';
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

/**
 * A Confirm still in flight when the page reloads or the section closes is replayed once on the next mount; its
 * idempotency key makes the replay return the same operation. A start that settled with an error is cleared, so only
 * a fresh Confirm in the dialog can run it again.
 */
interface Receipt {
  operationId?: string;
  pendingStart?: PendingStart;
}

// Keyed per account so a start fenced by sign-out can still be cleared under the account that made it.
const receiptKey = (owner: AccountScope = captureAccountScope()): string => {
  return `invokeai:webv2:intermediates-receipt:${owner.accountId ?? 'local'}${owner.storageSuffix}`;
};

const readReceipt = (owner?: AccountScope): Receipt => {
  try {
    return JSON.parse(sessionStorage.getItem(receiptKey(owner)) ?? '{}') as Receipt;
  } catch {
    return {};
  }
};

const writeReceipt = (receipt: Receipt, owner?: AccountScope): void => {
  try {
    if (!receipt.operationId && !receipt.pendingStart) {
      sessionStorage.removeItem(receiptKey(owner));
    } else {
      sessionStorage.setItem(receiptKey(owner), JSON.stringify(receipt));
    }
  } catch {
    // A private-mode storage failure still leaves the in-memory operation visible this session.
  }
};

/** Restores the followed operation and returns a start whose response was lost, if any. */
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

export const isPendingIntermediatesStartCurrent = (pendingStart: PendingStart, owner?: AccountScope): boolean => {
  const current = readReceipt(owner).pendingStart;
  return current?.previewId === pendingStart.previewId && current.idempotencyKey === pendingStart.idempotencyKey;
};

/** `owner` defaults to the current account; pass the one that recorded the start once it may have signed out. */
export const clearPendingIntermediatesStart = (owner?: AccountScope): void => {
  const { operationId } = readReceipt(owner);
  writeReceipt({ operationId }, owner);
};

registerAccountOwnedResource({
  clear: () => activeOperationStore.setSnapshot({ operationId: null }),
  name: 'intermediates-active-operation',
});

export const followIntermediatesOperation = (operationId: string | null): void => {
  activeOperationStore.setSnapshot({ operationId });
  writeReceipt({ operationId: operationId ?? undefined });
};
