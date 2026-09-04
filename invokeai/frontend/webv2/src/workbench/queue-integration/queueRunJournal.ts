import type { AccountScope } from '@platform/state/accountLifecycle';
import type { WorkbenchQueueItem } from '@workbench/queueHistoryContracts';

import { acquireAccountOwnedWorkbenchDatabase } from '@workbench/projects/accountOwnedWorkbenchDatabase';
import {
  isWorkbenchDatabaseAvailable,
  WORKBENCH_DATABASE_METADATA_STORE,
  WORKBENCH_QUEUE_RUN_STORE,
  type QueueRunDatabaseRecord,
  type WorkbenchDatabase,
} from '@workbench/projects/workbenchDatabase';

export const QUEUE_RUN_MAX_BYTES = 32 * 1024 * 1024;

export interface QueueRunJournalEntry {
  /** Untrusted serialized candidate. Normalize it against the current project before restoration. */
  item: unknown;
  projectId: string;
  queueItemId: string;
  submissionOrder: number;
}

export type QueueRunJournalLoadResult =
  | { entries: QueueRunJournalEntry[]; kind: 'available'; removedCorrupt: number }
  | { kind: 'unavailable' };
export type QueueRunJournalWriteResult = { kind: 'invalid' | 'quota' | 'stored' | 'too-large' | 'unavailable' };
export type QueueRunJournalSettleResult = { kind: 'removed' | 'unavailable' };

export interface QueueRunJournal {
  readonly availability: 'available' | 'unavailable';
  close(): void;
  listAll(): Promise<QueueRunJournalLoadResult>;
  listForProject(projectId: string): Promise<QueueRunJournalLoadResult>;
  record(projectId: string, item: WorkbenchQueueItem): Promise<QueueRunJournalWriteResult>;
  settle(projectId: string, queueItemId: string): Promise<QueueRunJournalSettleResult>;
}

const getByteSize = (value: string): number => new TextEncoder().encode(value).byteLength;
const QUEUE_RUN_SUBMISSION_SEQUENCE_KEY = 'queueRunSubmissionSequence';
const QUEUE_RUN_STORES = [WORKBENCH_DATABASE_METADATA_STORE, WORKBENCH_QUEUE_RUN_STORE] as const;
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
interface ActiveQueueItemEnvelope {
  cancellable: boolean;
  id: string;
  snapshot: { backendSubmission: object; sourceId: string; submittedAt: string };
  status: 'pending' | 'running';
}
const isActiveQueueItemEnvelope = (value: unknown): value is ActiveQueueItemEnvelope => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const item = value as Partial<ActiveQueueItemEnvelope>;
  const snapshot = item.snapshot as Partial<ActiveQueueItemEnvelope['snapshot']> | undefined;
  return (
    isNonEmptyString(item.id) &&
    (item.status === 'pending' || item.status === 'running') &&
    typeof item.cancellable === 'boolean' &&
    Boolean(snapshot && typeof snapshot === 'object') &&
    isNonEmptyString(snapshot?.sourceId) &&
    isNonEmptyString(snapshot?.submittedAt) &&
    Boolean(snapshot?.backendSubmission && typeof snapshot.backendSubmission === 'object')
  );
};
const getKey = (projectId: string, queueItemId: string): string => JSON.stringify([projectId, queueItemId]);
const isQuotaError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'name' in error && error.name === 'QuotaExceededError';
const observeTransaction = <T extends { done: Promise<unknown> }>(transaction: T): T => {
  void transaction.done.catch(() => undefined);
  return transaction;
};

const decodeRecord = (record: QueueRunDatabaseRecord, maxRunBytes: number): QueueRunJournalEntry | null => {
  if (
    !isNonEmptyString(record.projectId) ||
    !isNonEmptyString(record.queueItemId) ||
    record.schemaVersion !== 1 ||
    record.key !== getKey(record.projectId, record.queueItemId) ||
    typeof record.itemJson !== 'string' ||
    getByteSize(record.itemJson) > maxRunBytes ||
    !Number.isSafeInteger(record.submissionOrder) ||
    record.submissionOrder <= 0 ||
    typeof record.updatedAt !== 'number' ||
    !Number.isFinite(record.updatedAt) ||
    record.updatedAt < 0
  ) {
    return null;
  }
  try {
    const item: unknown = JSON.parse(record.itemJson);
    return isActiveQueueItemEnvelope(item) && item.id === record.queueItemId
      ? {
          item,
          projectId: record.projectId,
          queueItemId: record.queueItemId,
          submissionOrder: record.submissionOrder,
        }
      : null;
  } catch {
    return null;
  }
};

export const createIndexedDbQueueRunJournal = (
  database: WorkbenchDatabase,
  { maxRunBytes = QUEUE_RUN_MAX_BYTES }: { maxRunBytes?: number } = {}
): QueueRunJournal => {
  const runByteBudget =
    Number.isFinite(maxRunBytes) && maxRunBytes >= 0 ? Math.floor(maxRunBytes) : QUEUE_RUN_MAX_BYTES;
  let isClosed = false;
  let isUnavailable = false;
  const isAvailable = (): boolean => !isClosed && !isUnavailable && isWorkbenchDatabaseAvailable(database);
  const markUnavailable = (): void => {
    isUnavailable = true;
  };
  const load = async (projectId?: string): Promise<QueueRunJournalLoadResult> => {
    if (!isAvailable()) {
      return { kind: 'unavailable' };
    }
    try {
      const transaction = database.transaction(WORKBENCH_QUEUE_RUN_STORE, 'readwrite');
      const records = projectId
        ? await transaction.store.index('byProject').getAll(projectId)
        : await transaction.store.getAll();
      const entries: QueueRunJournalEntry[] = [];
      let removedCorrupt = 0;
      for (const record of records) {
        const entry = decodeRecord(record, runByteBudget);
        if (entry) {
          entries.push(entry);
        } else {
          removedCorrupt += 1;
          await transaction.store.delete(record.key);
        }
      }
      await transaction.done;
      entries.sort((left, right) => {
        const projectOrder = left.projectId.localeCompare(right.projectId);
        return projectOrder || right.submissionOrder - left.submissionOrder;
      });
      return { entries, kind: 'available', removedCorrupt };
    } catch {
      markUnavailable();
      return { kind: 'unavailable' };
    }
  };

  return {
    get availability() {
      return isAvailable() ? 'available' : 'unavailable';
    },
    close() {
      isClosed = true;
    },
    listAll: () => load(),
    listForProject(projectId) {
      return isNonEmptyString(projectId)
        ? load(projectId)
        : Promise.resolve({ entries: [], kind: 'available', removedCorrupt: 0 });
    },
    async record(projectId, item) {
      if (!isAvailable()) {
        return { kind: 'unavailable' };
      }
      if (!isNonEmptyString(projectId) || !isActiveQueueItemEnvelope(item)) {
        return { kind: 'invalid' };
      }
      let itemJson: string;
      try {
        itemJson = JSON.stringify(item);
      } catch {
        return { kind: 'invalid' };
      }
      if (getByteSize(itemJson) > runByteBudget) {
        return { kind: 'too-large' };
      }
      try {
        if (!isActiveQueueItemEnvelope(JSON.parse(itemJson))) {
          return { kind: 'invalid' };
        }
      } catch {
        return { kind: 'invalid' };
      }
      try {
        const transaction = observeTransaction(database.transaction(QUEUE_RUN_STORES, 'readwrite'));
        const runStore = transaction.objectStore(WORKBENCH_QUEUE_RUN_STORE);
        const metadataStore = transaction.objectStore(WORKBENCH_DATABASE_METADATA_STORE);
        const key = getKey(projectId, item.id);
        const existing = await runStore.get(key);
        let submissionOrder = existing?.submissionOrder;
        if (!Number.isSafeInteger(submissionOrder) || (submissionOrder as number) <= 0) {
          const sequence = await metadataStore.get(QUEUE_RUN_SUBMISSION_SEQUENCE_KEY);
          const current = Number.isSafeInteger(sequence?.value) && sequence!.value >= 0 ? sequence!.value : 0;
          submissionOrder = current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
          await metadataStore.put({ key: QUEUE_RUN_SUBMISSION_SEQUENCE_KEY, value: submissionOrder });
        }
        const stableSubmissionOrder = submissionOrder as number;
        const record: QueueRunDatabaseRecord = {
          itemJson,
          key,
          projectId,
          queueItemId: item.id,
          schemaVersion: 1,
          submissionOrder: stableSubmissionOrder,
          updatedAt: Date.now(),
        };
        await runStore.put(record);
        await transaction.done;
        return { kind: 'stored' };
      } catch (error) {
        if (isQuotaError(error)) {
          return { kind: 'quota' };
        }
        markUnavailable();
        return { kind: 'unavailable' };
      }
    },
    async settle(projectId, queueItemId) {
      if (!isAvailable()) {
        return { kind: 'unavailable' };
      }
      if (!isNonEmptyString(projectId) || !isNonEmptyString(queueItemId)) {
        return { kind: 'removed' };
      }
      try {
        await database.delete(WORKBENCH_QUEUE_RUN_STORE, getKey(projectId, queueItemId));
        return { kind: 'removed' };
      } catch {
        markUnavailable();
        return { kind: 'unavailable' };
      }
    },
  };
};

export const createAccountOwnedQueueRunJournal = async (
  owner: AccountScope,
  dependencies: Parameters<typeof acquireAccountOwnedWorkbenchDatabase>[1] = {}
): Promise<QueueRunJournal> => {
  const lease = await acquireAccountOwnedWorkbenchDatabase(owner, dependencies);
  if (!lease) {
    return {
      availability: 'unavailable',
      close: () => undefined,
      listAll: () => Promise.resolve({ kind: 'unavailable' }),
      listForProject: () => Promise.resolve({ kind: 'unavailable' }),
      record: () => Promise.resolve({ kind: 'unavailable' }),
      settle: () => Promise.resolve({ kind: 'unavailable' }),
    };
  }
  const journal = createIndexedDbQueueRunJournal(lease.database);
  let isReleased = false;
  return {
    ...journal,
    get availability() {
      return journal.availability;
    },
    close() {
      if (isReleased) {
        return;
      }
      isReleased = true;
      journal.close();
      lease.release();
    },
  };
};
