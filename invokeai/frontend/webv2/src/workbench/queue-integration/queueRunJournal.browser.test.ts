import type { WorkbenchQueueItem } from '@workbench/queueHistoryContracts';

import {
  deleteWorkbenchDatabase,
  openWorkbenchDatabase,
  type WorkbenchDatabase,
} from '@workbench/projects/workbenchDatabase';
import { afterEach, describe, expect, it } from 'vitest';

import { createIndexedDbQueueRunJournal } from './queueRunJournal';

const databases: WorkbenchDatabase[] = [];
const suffixes = new Set<string>();

const createJournal = async (options?: { maxRunBytes?: number }) => {
  const suffix = `:queue-journal-test:${crypto.randomUUID()}`;
  suffixes.add(suffix);
  const database = await openWorkbenchDatabase(suffix);
  databases.push(database);
  return { database, journal: createIndexedDbQueueRunJournal(database, options) };
};

const createItem = (overrides: Partial<WorkbenchQueueItem> = {}): WorkbenchQueueItem =>
  ({
    cancellable: true,
    id: 'queue-item-1',
    snapshot: {
      backendSubmission: { error: 'test fixture', kind: 'invalid' },
      canvas: { marker: 'canvas' },
      destination: 'gallery',
      filterIntermediateResults: true,
      galleryBoardId: null,
      graph: { edges: [], id: 'graph-1', label: 'Graph', nodes: [], updatedAt: 'now', version: 1 },
      presentation: { batchCount: 1 },
      sourceId: 'workflow',
      submittedAt: '2026-09-03T00:00:00.000Z',
      widgetInstances: {},
      widgetStates: {},
    },
    status: 'pending',
    ...overrides,
  }) as WorkbenchQueueItem;

const rejectFirstPutWithQuota = (database: WorkbenchDatabase): WorkbenchDatabase => {
  let isArmed = true;
  return new Proxy(database, {
    get(target, property) {
      if (property === 'transaction') {
        return (...args: unknown[]) => {
          const transaction = Reflect.apply(target.transaction, target, args);
          return new Proxy(transaction, {
            get(transactionTarget, transactionProperty) {
              if (transactionProperty === 'objectStore') {
                return (storeName: string) => {
                  const store = transactionTarget.objectStore(storeName);
                  if (storeName !== 'queueRuns') {
                    return store;
                  }
                  return new Proxy(store, {
                    get(storeTarget, storeProperty) {
                      if (storeProperty === 'put' && isArmed) {
                        return () => {
                          isArmed = false;
                          transactionTarget.abort();
                          throw new DOMException('quota', 'QuotaExceededError');
                        };
                      }
                      const value = Reflect.get(storeTarget, storeProperty, storeTarget) as unknown;
                      return typeof value === 'function' ? value.bind(storeTarget) : value;
                    },
                  });
                };
              }
              const value = Reflect.get(transactionTarget, transactionProperty, transactionTarget) as unknown;
              return typeof value === 'function' ? value.bind(transactionTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as WorkbenchDatabase;
};

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  for (const suffix of suffixes) {
    await deleteWorkbenchDatabase(suffix);
  }
  suffixes.clear();
});

describe('IndexedDB queue run journal', () => {
  it('round-trips active runs and coalesces status updates', async () => {
    const { journal } = await createJournal();
    await expect(journal.record('project-1', createItem())).resolves.toEqual({ kind: 'stored' });
    await expect(
      journal.record(
        'project-1',
        createItem({ backendBatchId: 'batch-1', backendItemIds: [11, 12], status: 'running' })
      )
    ).resolves.toEqual({ kind: 'stored' });

    await expect(journal.listForProject('project-1')).resolves.toMatchObject({
      entries: [
        {
          item: { backendBatchId: 'batch-1', backendItemIds: [11, 12], id: 'queue-item-1', status: 'running' },
          projectId: 'project-1',
          queueItemId: 'queue-item-1',
        },
      ],
      kind: 'available',
      removedCorrupt: 0,
    });
  });

  it('restores newest-first submission order without moving a run when its status changes', async () => {
    const { journal } = await createJournal();
    await journal.record('project-1', createItem({ id: 'queue-item-1' }));
    await journal.record('project-1', createItem({ id: 'queue-item-2' }));
    await journal.record('project-1', createItem({ id: 'queue-item-1', status: 'running' }));

    const loaded = await journal.listForProject('project-1');

    expect(loaded.kind === 'available' ? loaded.entries.map((entry) => entry.queueItemId) : []).toEqual([
      'queue-item-2',
      'queue-item-1',
    ]);
  });

  it('keeps project and item identities collision-free', async () => {
    const { journal } = await createJournal();
    await journal.record('a:b', createItem({ id: 'c' }));
    await journal.record('a', createItem({ id: 'b:c' }));

    await expect(journal.listAll()).resolves.toMatchObject({
      entries: [
        { item: { id: 'b:c' }, projectId: 'a' },
        { item: { id: 'c' }, projectId: 'a:b' },
      ],
      kind: 'available',
    });
  });

  it('settles idempotently and never stores terminal items', async () => {
    const { journal } = await createJournal();
    await expect(journal.record('project-1', createItem({ status: 'completed' }))).resolves.toEqual({
      kind: 'invalid',
    });
    await journal.record('project-1', createItem());
    await expect(journal.settle('project-1', 'queue-item-1')).resolves.toEqual({ kind: 'removed' });
    await expect(journal.settle('project-1', 'queue-item-1')).resolves.toEqual({ kind: 'removed' });
    await expect(journal.listAll()).resolves.toMatchObject({ entries: [], kind: 'available' });
  });

  it('skips corrupt rows without hiding valid runs', async () => {
    const { database, journal } = await createJournal();
    await journal.record('project-1', createItem());
    await database.put('queueRuns', {
      itemJson: '{broken',
      key: '["project-2","queue-item-2"]',
      projectId: 'project-2',
      queueItemId: 'queue-item-2',
      schemaVersion: 1,
      submissionOrder: 2,
      updatedAt: 1,
    });

    await expect(journal.listAll()).resolves.toMatchObject({
      entries: [{ item: { id: 'queue-item-1' }, projectId: 'project-1' }],
      kind: 'available',
      removedCorrupt: 1,
    });
    expect(await database.get('queueRuns', '["project-2","queue-item-2"]')).toBeUndefined();
  });

  it('keeps restored payloads untrusted until the project-aware normalizer accepts them', async () => {
    const { database, journal } = await createJournal();
    const item = createItem();
    await database.put('queueRuns', {
      itemJson: JSON.stringify({
        cancellable: true,
        id: item.id,
        snapshot: { backendSubmission: {}, sourceId: 'workflow', submittedAt: 'now' },
        status: 'pending',
      }),
      key: '["project-1","queue-item-1"]',
      projectId: 'project-1',
      queueItemId: 'queue-item-1',
      schemaVersion: 1,
      submissionOrder: 1,
      updatedAt: 1,
    });

    const loaded = await journal.listAll();
    expect(loaded).toMatchObject({ kind: 'available', removedCorrupt: 0 });
    if (loaded.kind === 'available') {
      const candidate: unknown = loaded.entries[0]?.item;
      expect(candidate).toMatchObject({ id: 'queue-item-1' });
    }
  });

  it('rejects malformed and oversized records without poisoning the journal', async () => {
    const baselineBytes = new TextEncoder().encode(JSON.stringify(createItem())).byteLength;
    const { journal } = await createJournal({ maxRunBytes: baselineBytes + 8 });
    await expect(journal.record('', createItem())).resolves.toEqual({ kind: 'invalid' });
    await expect(journal.record('project-1', createItem({ id: '' }))).resolves.toEqual({ kind: 'invalid' });
    const cyclic = createItem() as WorkbenchQueueItem & { cycle?: unknown };
    cyclic.cycle = cyclic;
    await expect(journal.record('project-1', cyclic)).resolves.toEqual({ kind: 'invalid' });
    await expect(journal.record('project-1', createItem({ error: 'x'.repeat(256) }))).resolves.toEqual({
      kind: 'too-large',
    });
    await expect(journal.record('project-1', createItem())).resolves.toEqual({ kind: 'stored' });
  });

  it('prunes oversized rows written by an older or less restrictive client', async () => {
    const item = createItem({ error: 'x'.repeat(256) });
    const baselineBytes = new TextEncoder().encode(JSON.stringify(createItem())).byteLength;
    const { database, journal } = await createJournal({ maxRunBytes: baselineBytes + 8 });
    await database.put('queueRuns', {
      itemJson: JSON.stringify(item),
      key: '["project-1","queue-item-1"]',
      projectId: 'project-1',
      queueItemId: 'queue-item-1',
      schemaVersion: 1,
      submissionOrder: 1,
      updatedAt: 1,
    });

    await expect(journal.listAll()).resolves.toEqual({ entries: [], kind: 'available', removedCorrupt: 1 });
    expect(await database.count('queueRuns')).toBe(0);
  });

  it('reports quota without poisoning later writes', async () => {
    const { database } = await createJournal();
    const journal = createIndexedDbQueueRunJournal(rejectFirstPutWithQuota(database));

    await expect(journal.record('project-1', createItem())).resolves.toEqual({ kind: 'quota' });
    expect(journal.availability).toBe('available');
    await expect(journal.record('project-1', createItem())).resolves.toEqual({ kind: 'stored' });
  });
});
