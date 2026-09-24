import type { IntermediatesOperation } from '@features/intermediates/core/types';
import type { QueryClient } from '@tanstack/react-query';

import {
  captureAccountScope,
  isAccountScopeCurrent,
  registerAccountOwnedResource,
  type AccountScope,
} from '@platform/state/accountLifecycle';
import { createExternalStore } from '@platform/state/externalStore';

import { getIntermediatesOperation, startIntermediatesOperation } from './api';
import { intermediatesKeys } from './keys';
import { attachIntermediatesRealtime } from './realtime';

/**
 * The operation the manager is following. Kept outside the component so closing Settings while a cleanup runs and
 * reopening it later shows the same operation, its result and its retry affordance.
 */
export const activeOperationStore = createExternalStore<{
  operationId: string | null;
  /** Why replaying a start whose response was lost failed; cleared when the manager next opens. */
  recoveryError: unknown;
}>({ operationId: null, recoveryError: null });

interface PendingStart {
  previewId: string;
  idempotencyKey: string;
}

/**
 * A Confirm whose response never arrived (a reload, a closed section, a timeout) is replayed once when the manager
 * next opens; its idempotency key makes the replay return the same operation. A start that settled with an error is
 * cleared, so only a fresh Confirm in the dialog can run it again.
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

export const recordPendingIntermediatesStart = (pendingStart: PendingStart): void => {
  writeReceipt({ ...readReceipt(), pendingStart });
};

const isPendingStartCurrent = (pendingStart: PendingStart, owner?: AccountScope): boolean => {
  const current = readReceipt(owner).pendingStart;
  return current?.previewId === pendingStart.previewId && current.idempotencyKey === pendingStart.idempotencyKey;
};

/** `owner` defaults to the current account; pass the one that recorded the start once it may have signed out. */
export const clearPendingIntermediatesStart = (owner?: AccountScope): void => {
  const { operationId } = readReceipt(owner);
  writeReceipt({ operationId }, owner);
};

registerAccountOwnedResource({
  clear: () => activeOperationStore.setSnapshot({ operationId: null, recoveryError: null }),
  name: 'intermediates-active-operation',
});

export const followIntermediatesOperation = (operationId: string | null): void => {
  activeOperationStore.patchSnapshot({ operationId });
  writeReceipt({ operationId: operationId ?? undefined });
};

/** Follows an operation the server just returned, seeding its query so the panel needs no extra lookup. */
export const adoptIntermediatesOperation = (
  queryClient: QueryClient,
  owner: AccountScope,
  operation: IntermediatesOperation
): void => {
  queryClient.setQueryData(intermediatesKeys.operation(owner, operation.operationId), operation);
  followIntermediatesOperation(operation.operationId);
};

/** Walks the retry chain to the operation that currently owns the unresolved targets. */
export const findLatestIntermediatesRetry = async (
  operationId: string,
  signal: AbortSignal
): Promise<IntermediatesOperation> => {
  let operation = await getIntermediatesOperation(operationId, signal);
  const visited = new Set<string>([operationId]);
  while (operation.retriedByOperationId && !visited.has(operation.retriedByOperationId)) {
    visited.add(operation.retriedByOperationId);
    operation = await getIntermediatesOperation(operation.retriedByOperationId, signal);
  }
  return operation;
};

let attachedManagers = 0;
// Single-flight per account and receipt, so a remount (or StrictMode's replayed mount) never repeats the request.
const reconciling = new Set<string>();

const runOnce = (key: string, work: () => Promise<void>): void => {
  if (reconciling.has(key)) {
    return;
  }
  reconciling.add(key);
  void work().finally(() => reconciling.delete(key));
};

const replayPendingStart = (queryClient: QueryClient, owner: AccountScope, pending: PendingStart): void => {
  runOnce(`${receiptKey(owner)}\u0000start\u0000${pending.idempotencyKey}`, async () => {
    try {
      const operation = await startIntermediatesOperation(pending, owner.signal);
      if (isAccountScopeCurrent(owner) && isPendingStartCurrent(pending)) {
        adoptIntermediatesOperation(queryClient, owner, operation);
      }
    } catch (error) {
      if (isPendingStartCurrent(pending, owner)) {
        clearPendingIntermediatesStart(owner);
        if (attachedManagers > 0 && isAccountScopeCurrent(owner)) {
          activeOperationStore.patchSnapshot({ recoveryError: error });
        }
      }
    }
  });
};

const catchUpWithRetry = (queryClient: QueryClient, owner: AccountScope, followed: string): void => {
  runOnce(`${receiptKey(owner)}\u0000retry\u0000${followed}`, async () => {
    try {
      const operation = await findLatestIntermediatesRetry(followed, owner.signal);
      if (
        isAccountScopeCurrent(owner) &&
        activeOperationStore.getSnapshot().operationId === followed &&
        operation.operationId !== followed
      ) {
        adoptIntermediatesOperation(queryClient, owner, operation);
      }
    } catch {
      // The operation query reports lookup failures in the panel.
    }
  });
};

/**
 * Registers an open manager: attaches realtime updates for its lifetime and reconciles the receipt, replaying a
 * Confirm whose response was lost or catching up with a retry started elsewhere.
 */
export const attachIntermediatesManager = (queryClient: QueryClient): (() => void) => {
  if (attachedManagers === 0) {
    activeOperationStore.patchSnapshot({ recoveryError: null });
  }
  attachedManagers += 1;
  const detachRealtime = attachIntermediatesRealtime(queryClient);
  const owner = captureAccountScope();
  const receipt = readReceipt(owner);
  if (typeof receipt.operationId === 'string' && receipt.operationId.length > 0) {
    activeOperationStore.patchSnapshot({ operationId: receipt.operationId });
  }
  const followed = activeOperationStore.getSnapshot().operationId;
  if (receipt.pendingStart) {
    replayPendingStart(queryClient, owner, receipt.pendingStart);
  } else if (followed) {
    catchUpWithRetry(queryClient, owner, followed);
  }

  let attached = true;
  return () => {
    if (attached) {
      attached = false;
      attachedManagers -= 1;
      detachRealtime();
    }
  };
};
