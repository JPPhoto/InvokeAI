import type {
  GalleryItem,
  GalleryItemKey,
  GalleryItemMutationResult,
  GalleryItemRef,
  GalleryItemsPage,
} from '@features/gallery/core/items';
import type { GalleryBoard } from '@features/gallery/core/types';
import type { AccountScope } from '@platform/state/accountLifecycle';
import type { InfiniteData, Query, QueryClient, QueryKey } from '@tanstack/react-query';

import { toGalleryItemKey } from '@features/gallery/core/items';
import { pruneImageClusterMembers } from '@features/gallery/core/semanticImageQuery';
import { captureAccountScope } from '@platform/state/accountLifecycle';
import { rollBackUnclaimedEntries } from '@platform/state/compareAndSwapRollback';
import { hashKey, InfiniteQueryObserver } from '@tanstack/react-query';

import { ALL_READABLE_BOARDS_ID, isDateBoardId } from './backend';
import {
  fetchGalleryItemsRange,
  GALLERY_MAX_INFINITE_PAGES,
  GALLERY_PAGE_SIZE,
  galleryKeys,
  galleryItemsInfiniteOptions,
  getGalleryItemListQueries,
  getGalleryItemsFilterFromKey,
  isGalleryStarredStripQueryKey,
  type CanonicalGalleryItemsFilter,
  type GalleryItemsFilter,
  type GalleryItemsListQueryKey,
} from './queries';

export type GalleryItemCachePatch =
  | { kind: 'delete'; result: GalleryItemMutationResult }
  | { boardId: string; kind: 'move'; result: GalleryItemMutationResult }
  | { kind: 'star'; result: GalleryItemMutationResult; starred: boolean };

/** A list window's pages, or the starred strip's single page. */
type GalleryItemsCacheData = InfiniteData<GalleryItemsPage, number> | GalleryItemsPage;

interface ItemCacheRollbackEntry {
  after: GalleryItemsCacheData;
  before: GalleryItemsCacheData;
  queryKey: QueryKey;
}

const isGalleryItemsData = (value: unknown): value is InfiniteData<GalleryItemsPage, number> => {
  if (!value || typeof value !== 'object' || !('pages' in value) || !('pageParams' in value)) {
    return false;
  }

  const data = value as { pages?: unknown; pageParams?: unknown };

  return Array.isArray(data.pages) && Array.isArray(data.pageParams);
};

const isGalleryItemsPage = (value: unknown): value is GalleryItemsPage =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as { items?: unknown }).items) &&
  typeof (value as { total?: unknown }).total === 'number';

/** The pages a list-family cache entry holds, whichever shape it is. */
const getCachedPages = (query: Query): GalleryItemsPage[] => {
  const data = query.state.data;

  if (isGalleryItemsData(data)) {
    return data.pages;
  }

  return isGalleryStarredStripQueryKey(query.queryKey) && isGalleryItemsPage(data) ? [data] : [];
};

const mapPageItems = (
  page: GalleryItemsPage,
  mapItem: (item: GalleryItem) => GalleryItem | null,
  totalDelta = 0
): GalleryItemsPage => {
  let changed = false;
  const items: GalleryItem[] = [];
  const itemIndices: number[] = [];

  for (const [index, item] of page.items.entries()) {
    const nextItem = mapItem(item);

    if (nextItem !== item) {
      changed = true;
    }
    if (nextItem) {
      items.push(nextItem);
      if (page.itemIndices) {
        itemIndices.push(page.itemIndices[index]!);
      }
    }
  }

  if (!changed && totalDelta === 0) {
    return page;
  }

  return {
    ...page,
    items: changed ? items : page.items,
    ...(page.itemIndices ? { itemIndices: changed ? itemIndices : page.itemIndices } : {}),
    total: Math.max(0, page.total - totalDelta),
  };
};

/** Cluster windows ignore board moves; starred-only listings lose items immediately when unstarred. */
const patchRemovesItems = (filter: CanonicalGalleryItemsFilter, patch: GalleryItemCachePatch): boolean => {
  if (patch.kind === 'delete') {
    return true;
  }

  if (patch.kind === 'star') {
    return filter.starred !== undefined && filter.starred !== patch.starred;
  }

  return (
    filter.semantic?.kind !== 'cluster' &&
    filter.boardId !== ALL_READABLE_BOARDS_ID &&
    filter.boardId !== patch.boardId &&
    !isDateBoardId(filter.boardId)
  );
};

const patchItemPage = (
  page: GalleryItemsPage,
  filter: CanonicalGalleryItemsFilter,
  patch: GalleryItemCachePatch,
  itemKeys: ReadonlySet<GalleryItemKey>,
  removedItemCount: number
): GalleryItemsPage => {
  if (patchRemovesItems(filter, patch)) {
    return mapPageItems(page, (item) => (itemKeys.has(toGalleryItemKey(item)) ? null : item), removedItemCount);
  }

  return mapPageItems(page, (item) => {
    if (!itemKeys.has(toGalleryItemKey(item))) {
      return item;
    }

    if (patch.kind === 'star') {
      return item.starred === patch.starred ? item : { ...item, starred: patch.starred };
    }

    if (patch.kind === 'move') {
      return item.boardId === patch.boardId ? item : { ...item, boardId: patch.boardId };
    }

    return item;
  });
};

const countRemovedItems = (page: GalleryItemsPage, itemKeys: ReadonlySet<GalleryItemKey>): number =>
  page.items.filter((item) => itemKeys.has(toGalleryItemKey(item))).length;

const patchItemsInfiniteData = (
  data: InfiniteData<GalleryItemsPage, number>,
  filter: CanonicalGalleryItemsFilter,
  patch: GalleryItemCachePatch,
  itemKeys: ReadonlySet<GalleryItemKey>
): InfiniteData<GalleryItemsPage, number> => {
  const removedItemKeys = new Set<GalleryItemKey>();

  if (patchRemovesItems(filter, patch)) {
    for (const page of data.pages) {
      for (const item of page.items) {
        const key = toGalleryItemKey(item);

        if (itemKeys.has(key)) {
          removedItemKeys.add(key);
        }
      }
    }
  }

  let changed = false;
  const pages = data.pages.map((page) => {
    const nextPage = patchItemPage(page, filter, patch, itemKeys, removedItemKeys.size);
    changed ||= nextPage !== page;

    return nextPage;
  });

  return changed ? { ...data, pages } : data;
};

const patchItemsCacheData = (
  query: Query,
  filter: CanonicalGalleryItemsFilter,
  patch: GalleryItemCachePatch,
  itemKeys: ReadonlySet<GalleryItemKey>
): { after: GalleryItemsCacheData; before: GalleryItemsCacheData } | null => {
  const before = query.state.data;

  if (isGalleryItemsData(before)) {
    return { after: patchItemsInfiniteData(before, filter, patch, itemKeys), before };
  }

  // A newly starred item is left to the trailing refetch, which knows where
  // it belongs chronologically in the strip.
  if (isGalleryStarredStripQueryKey(query.queryKey) && isGalleryItemsPage(before)) {
    return { after: patchItemPage(before, filter, patch, itemKeys, countRemovedItems(before, itemKeys)), before };
  }

  return null;
};

/**
 * Applies only backend-confirmed successes. Failed refs are intentionally
 * ignored, and kind-qualified keys prevent same-name images/videos colliding.
 */
export const patchGalleryItemCaches = (client: QueryClient, patch: GalleryItemCachePatch): (() => void) => {
  const itemKeys = new Set(patch.result.succeeded.map(toGalleryItemKey));

  if (itemKeys.size === 0) {
    return () => undefined;
  }

  // The cluster filter's member list is client-owned, so a server refetch can
  // never reconcile it: prune it in the same optimistic step (and restore it
  // with the same rollback) as the list caches it feeds.
  const rollbackClusterMembers =
    patch.kind === 'delete' ? pruneImageClusterMembers(patch.result.succeeded.map(toGalleryItemKey)) : null;
  const rollbackEntries: ItemCacheRollbackEntry[] = [];

  for (const query of getGalleryItemListQueries(client)) {
    const filter = getGalleryItemsFilterFromKey(query.queryKey);
    const patched = filter ? patchItemsCacheData(query, filter, patch, itemKeys) : null;

    if (!patched || patched.after === patched.before) {
      continue;
    }

    const applied = client.setQueryData<GalleryItemsCacheData>(query.queryKey, patched.after);

    if (applied) {
      rollbackEntries.push({ after: applied, before: patched.before, queryKey: query.queryKey });
    }
  }

  return () => {
    rollbackClusterMembers?.();
    rollBackUnclaimedEntries(
      rollbackEntries,
      (entry) => client.getQueryData<GalleryItemsCacheData>(entry.queryKey),
      (entry) => client.setQueryData(entry.queryKey, entry.before)
    );
  };
};

/** Capture cached source boards before optimistic moves so rejected refs can be restored before refetch. */
export const getGalleryItemBoardIdsFromCaches = (
  client: QueryClient,
  refs: readonly GalleryItemRef[]
): Map<GalleryItemKey, string> => {
  const wanted = new Set(refs.map(toGalleryItemKey));
  const boardIds = new Map<GalleryItemKey, string>();

  for (const query of getGalleryItemListQueries(client)) {
    if (boardIds.size === wanted.size) {
      break;
    }

    for (const page of getCachedPages(query)) {
      for (const item of page.items) {
        const key = toGalleryItemKey(item);

        if (wanted.has(key) && !boardIds.has(key)) {
          boardIds.set(key, item.boardId);
        }
      }
    }
  }

  return boardIds;
};

/**
 * Capture each cached starred flag before mutation; failed batches must restore actual prior values rather than
 * invert the request.
 */
export const getGalleryItemStarredFromCaches = (
  client: QueryClient,
  refs: readonly GalleryItemRef[]
): Map<GalleryItemKey, boolean> => {
  const wanted = new Set(refs.map(toGalleryItemKey));
  const starred = new Map<GalleryItemKey, boolean>();

  for (const query of getGalleryItemListQueries(client)) {
    if (starred.size === wanted.size) {
      break;
    }

    for (const page of getCachedPages(query)) {
      for (const item of page.items) {
        const key = toGalleryItemKey(item);

        if (wanted.has(key) && !starred.has(key)) {
          starred.set(key, item.starred);
        }
      }
    }
  }

  return starred;
};

interface BoardCacheRollbackEntry {
  after: GalleryBoard[];
  before: GalleryBoard[];
  queryKey: QueryKey;
}

const isGalleryBoardsData = (value: unknown): value is GalleryBoard[] =>
  Array.isArray(value) && value.every((board) => typeof board === 'object' && board !== null && 'id' in board);

/**
 * Patches one board across every cached board list and returns a rollback
 * that restores the prior lists — skipping any list something else has
 * written to since, the same conflict rule as `patchGalleryItemCaches`.
 */
export const patchGalleryBoardCaches = (
  client: QueryClient,
  boardId: string,
  changes: Partial<Pick<GalleryBoard, 'archived' | 'name'>>
): (() => void) => {
  const owner = captureAccountScope();
  const rollbackEntries: BoardCacheRollbackEntry[] = [];

  for (const query of client.getQueryCache().findAll({ queryKey: galleryKeys.boardsForAccount(owner) })) {
    const before = query.state.data;

    if (!isGalleryBoardsData(before)) {
      continue;
    }

    let changed = false;
    const after = before.map((board) => {
      if (board.id !== boardId) {
        return board;
      }

      changed = true;
      return { ...board, ...changes };
    });

    if (!changed) {
      continue;
    }

    const applied = client.setQueryData<GalleryBoard[]>(query.queryKey, after);

    if (applied) {
      rollbackEntries.push({ after: applied, before, queryKey: query.queryKey });
    }
  }

  return () =>
    rollBackUnclaimedEntries(
      rollbackEntries,
      (entry) => client.getQueryData<InfiniteData<GalleryItemsPage, number>>(entry.queryKey),
      (entry) => client.setQueryData(entry.queryKey, entry.before)
    );
};

/** The contiguous row range a window's pages cover, or null for a shape the rebuild cannot reason about. */
const getGalleryWindowSpan = (
  data: InfiniteData<GalleryItemsPage, number>
): { offset: number; rowCount: number } | null => {
  const [firstOffset] = data.pageParams;

  if (typeof firstOffset !== 'number') {
    return null;
  }

  const isContiguous = data.pageParams.every(
    (pageParam, index) => pageParam === firstOffset + index * GALLERY_PAGE_SIZE
  );

  return isContiguous ? { offset: firstOffset, rowCount: data.pageParams.length * GALLERY_PAGE_SIZE } : null;
};

/**
 * Swaps an active window's pages atomically from one span-sized read. False
 * falls back to the collapse: the read failed or the entry changed meanwhile.
 */
const rebuildGalleryItemWindow = async (client: QueryClient, owner: AccountScope, query: Query): Promise<boolean> => {
  const filter = getGalleryItemsFilterFromKey(query.queryKey);
  const before = query.state.data;

  if (!filter || !isGalleryItemsData(before)) {
    return false;
  }

  const span = getGalleryWindowSpan(before);

  if (!span) {
    return false;
  }

  // Name-hydrated windows fetch videos one by one; re-reading a video-heavy
  // span every mutation would cost more than the collapse ever did.
  if (
    (filter.semantic !== undefined || isDateBoardId(filter.boardId)) &&
    before.pages.reduce((count, page) => count + page.items.filter((item) => item.kind === 'video').length, 0) >
      GALLERY_PAGE_SIZE
  ) {
    return false;
  }

  let result: GalleryItemsPage;

  try {
    result = await fetchGalleryItemsRange(client, owner, filter, {
      limit: span.rowCount,
      offset: span.offset,
      signal: owner.signal,
    });
  } catch {
    return false;
  }

  const liveQuery = client.getQueryCache().get(query.queryHash);

  // A page fetch that started during the span read snapshotted the old pages
  // and will land after this swap; only an idle, untouched entry may take it.
  if (liveQuery?.state.data !== before || liveQuery.state.fetchStatus !== 'idle') {
    return false;
  }
  if (!result.itemIndices && result.items.length < span.rowCount && span.offset + result.items.length < result.total) {
    return false;
  }

  const pages: GalleryItemsPage[] =
    result.items.length === 0
      ? [{ items: [], total: result.total }]
      : Array.from({ length: span.rowCount / GALLERY_PAGE_SIZE }, (_, pageIndex) => {
          const pageOffset = span.offset + pageIndex * GALLERY_PAGE_SIZE;
          const pageItems: GalleryItem[] = [];
          const itemIndices: number[] = [];

          result.items.forEach((item, itemIndex) => {
            const absoluteIndex = result.itemIndices?.[itemIndex] ?? span.offset + itemIndex;

            if (absoluteIndex >= pageOffset && absoluteIndex < pageOffset + GALLERY_PAGE_SIZE) {
              pageItems.push(item);
              itemIndices.push(absoluteIndex);
            }
          });

          return {
            items: pageItems,
            ...(result.itemIndices ? { itemIndices } : {}),
            total: result.total,
          };
        });

  // TanStack never stores zero pages; an emptied span keeps one empty page.
  if (pages.length === 0) {
    pages.push({ items: [], total: result.total });
  }

  client.setQueryData<InfiniteData<GalleryItemsPage, number>>(query.queryKey, {
    pageParams: pages.map((_, index) => span.offset + index * GALLERY_PAGE_SIZE),
    pages,
  });

  return true;
};

/** Collapses a window to its anchor page, so its refetch replays one request. */
const collapseGalleryItemWindowToAnchor = (client: QueryClient, query: Query): void => {
  // A transient entry (anchored windows carry gcTime 0) may have been
  // collected while a rebuild awaited; writing to its key would resurrect it.
  if (client.getQueryCache().get(query.queryHash) !== query) {
    return;
  }

  const data = query.state.data;

  if (!isGalleryItemsData(data) || data.pages.length <= 1) {
    return;
  }

  const anchorOffset =
    (query.queryKey[5] === 'anchor' || query.queryKey[5] === 'infinite') && typeof query.queryKey[6] === 'number'
      ? query.queryKey[6]
      : 0;
  const anchorIndex = Math.max(0, data.pageParams.indexOf(anchorOffset));

  client.setQueryData<InfiniteData<GalleryItemsPage, number>>(query.queryKey, {
    pageParams: [data.pageParams[anchorIndex] ?? anchorOffset],
    pages: [data.pages[anchorIndex] ?? data.pages[0]],
  });
};

const runGalleryInvalidation = async (
  client: QueryClient,
  owner: AccountScope,
  includeBoards: boolean
): Promise<void> => {
  // Date-board pages and lazy range selection share these names. Mark them
  // stale before active pages refetch so they cannot hydrate stale refs.
  await client.cancelQueries({ queryKey: galleryKeys.itemNamesForAccount(owner) });
  await client.invalidateQueries({
    queryKey: galleryKeys.itemNamesForAccount(owner),
    refetchType: 'none',
  });
  await client.cancelQueries({ queryKey: galleryKeys.itemListsForAccount(owner) });

  const rebuiltQueryHashes = new Set<string>();

  // Rebuild active windows in one span to preserve viewport rows; unobserved windows collapse to their pinned
  // page.
  for (const query of getGalleryItemListQueries(client, owner)) {
    const data = query.state.data;

    if (!isGalleryItemsData(data) || data.pages.length <= 1) {
      continue;
    }

    if (query.isActive() && (await rebuildGalleryItemWindow(client, owner, query))) {
      rebuiltQueryHashes.add(query.queryHash);
      continue;
    }

    collapseGalleryItemWindowToAnchor(client, query);
  }

  await client.invalidateQueries({
    predicate: (query) => !rebuiltQueryHashes.has(query.queryHash),
    queryKey: galleryKeys.itemListsForAccount(owner),
  });

  if (includeBoards) {
    await client.invalidateQueries({ queryKey: galleryKeys.boardsForAccount(owner) });
  }
};

interface GalleryInvalidationState {
  includeBoards: boolean;
  promise: Promise<void> | null;
  requested: boolean;
}

const galleryInvalidations = new WeakMap<QueryClient, Map<string, GalleryInvalidationState>>();

/**
 * Coalesce same-tick invalidations with at most one trailing pass to avoid cancelling and restarting observed
 * refetches.
 */
const scheduleGalleryInvalidation = (
  client: QueryClient,
  owner: AccountScope,
  includeBoards: boolean
): Promise<void> => {
  const ownerKey = hashKey(galleryKeys.itemListsForAccount(owner));
  const clientStates = galleryInvalidations.get(client) ?? new Map<string, GalleryInvalidationState>();
  const state = clientStates.get(ownerKey) ?? {
    includeBoards: false,
    promise: null,
    requested: false,
  };

  galleryInvalidations.set(client, clientStates);
  clientStates.set(ownerKey, state);
  state.includeBoards ||= includeBoards;
  state.requested = true;

  if (!state.promise) {
    state.promise = (async () => {
      try {
        // Let a synchronous burst collapse into one pass.
        await Promise.resolve();

        while (state.requested) {
          state.requested = false;
          const shouldInvalidateBoards = state.includeBoards;

          state.includeBoards = false;
          await runGalleryInvalidation(client, owner, shouldInvalidateBoards);
        }
      } finally {
        state.promise = null;
        clientStates.delete(ownerKey);
      }
    })();
  }

  return state.promise;
};

export const invalidateGalleryItems = (
  client: QueryClient,
  owner: AccountScope = captureAccountScope()
): Promise<void> => scheduleGalleryInvalidation(client, owner, false);

export const invalidateGallery = (client: QueryClient, owner: AccountScope = captureAccountScope()): Promise<void> =>
  scheduleGalleryInvalidation(client, owner, true);

export type GalleryWindowLoadAction =
  | { kind: 'none' }
  | { kind: 'next' }
  | { kind: 'previous' }
  | { kind: 'reanchor'; offset: number };

const pageOffsetForIndex = (index: number): number =>
  Math.floor(Math.max(0, index) / GALLERY_PAGE_SIZE) * GALLERY_PAGE_SIZE;

/** Chooses one bounded request step that moves a retained page window toward a visible index range. */
export const getGalleryWindowLoadAction = (input: {
  first: number;
  last: number;
  pageOffsets: readonly number[];
  /** Defaults to the retained query budget; oversized viewports may request a larger bounded window. */
  maxPages?: number;
}): GalleryWindowLoadAction => {
  const { first, last, pageOffsets } = input;
  const firstOffset = pageOffsetForIndex(first);
  const lastOffset = pageOffsetForIndex(Math.max(first, last));
  const requestedPages = (lastOffset - firstOffset) / GALLERY_PAGE_SIZE + 1;
  const maxPages = Math.max(GALLERY_MAX_INFINITE_PAGES, Math.floor(input.maxPages ?? GALLERY_MAX_INFINITE_PAGES));

  if (requestedPages > maxPages) {
    return { kind: 'reanchor', offset: firstOffset };
  }

  if (pageOffsets.length === 0) {
    return { kind: 'reanchor', offset: firstOffset };
  }

  const firstLoadedOffset = pageOffsets[0];
  const lastLoadedOffset = pageOffsets[pageOffsets.length - 1];

  if (firstOffset < firstLoadedOffset) {
    if (lastOffset >= firstLoadedOffset && lastOffset <= lastLoadedOffset) {
      return { kind: 'previous' };
    }
    const gapPages = (firstLoadedOffset - firstOffset) / GALLERY_PAGE_SIZE;
    return gapPages > 1 ? { kind: 'reanchor', offset: firstOffset } : { kind: 'previous' };
  }

  if (lastOffset > lastLoadedOffset) {
    if (firstOffset >= firstLoadedOffset && firstOffset <= lastLoadedOffset) {
      return { kind: 'next' };
    }
    const gapPages = (lastOffset - lastLoadedOffset) / GALLERY_PAGE_SIZE;
    return gapPages > 1 ? { kind: 'reanchor', offset: firstOffset } : { kind: 'next' };
  }

  return { kind: 'none' };
};

type GalleryQueryResult = ReturnType<GalleryObserver['getCurrentResult']>;
type GalleryObserver = InfiniteQueryObserver<
  GalleryItemsPage,
  Error,
  InfiniteData<GalleryItemsPage, number>,
  GalleryItemsListQueryKey,
  number
>;

export interface GalleryWindowSnapshot {
  /** Keep the absolute spacer stable while a distant window is loading. */
  total: number | null;
  offset: number;
  result: GalleryQueryResult;
}

export interface GalleryWindowRuntime {
  getSnapshot: () => GalleryWindowSnapshot;
  subscribe: (listener: () => void) => () => void;
  loadRange: (first: number, last: number) => void;
  retry: () => void;
}

interface GalleryWindowRange {
  first: number;
  last: number;
}

interface CreateGalleryWindowRuntimeArgs {
  consumerId: string;
  filter: GalleryItemsFilter;
  initialOffset: number;
  isPaginated: boolean;
  queryClient: QueryClient;
}

const normalizeRange = (first: number, last: number): GalleryWindowRange => {
  const start = Math.max(0, Math.floor(first));
  return { first: start, last: Math.max(start, Math.floor(last)) };
};

export const createGalleryWindowRuntime = ({
  consumerId,
  filter,
  initialOffset,
  isPaginated,
  queryClient,
}: CreateGalleryWindowRuntimeArgs): GalleryWindowRuntime => {
  const listeners = new Set<() => void>();
  let anchorOffset = Math.max(0, Math.floor(initialOffset / GALLERY_PAGE_SIZE) * GALLERY_PAGE_SIZE);
  let observer: GalleryObserver | null = null;
  let observerUnsubscribe: (() => void) | null = null;
  let snapshot: GalleryWindowSnapshot | null = null;
  let knownTotal: number | null = null;
  let latestRange: GalleryWindowRange | null = null;
  let pendingRange: GalleryWindowRange | null = null;
  let failedRange: GalleryWindowRange | null = null;
  let activeOperation: object | null = null;
  let retryRequested = false;
  let generation = 0;
  let disposed = false;
  let invalidationPending = false;
  let invalidationFingerprint: string | null = null;
  let invalidationToken: object | null = null;
  const owner = captureAccountScope();

  const getObserverOptions = (offset: number, maxPages = GALLERY_MAX_INFINITE_PAGES) => {
    const options = galleryItemsInfiniteOptions(
      filter,
      {
        kind: isPaginated ? 'anchor' : 'infinite',
        offset,
      },
      `${consumerId}:${generation}`
    );

    return { ...options, maxPages };
  };

  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const isOwnerCurrent = (): boolean => !owner.signal.aborted;

  const updateSnapshot = (result: GalleryQueryResult): void => {
    const firstPageOffset = result.data?.pageParams[0];
    const pages = result.data?.pages;
    // A consistent multi-page window proves repair; a collapsed fallback alone must not allow a refetch loop.
    if (
      invalidationFingerprint !== null &&
      pages &&
      pages.length > 1 &&
      pages.every((page) => page.total === pages[0]?.total)
    ) {
      invalidationFingerprint = null;
    }
    knownTotal = result.data?.pages[0]?.total ?? knownTotal;
    snapshot = { offset: firstPageOffset ?? anchorOffset, result, total: knownTotal };
    notify();
  };

  const stopObserver = (): void => {
    generation += 1;
    activeOperation = null;
    observerUnsubscribe?.();
    observerUnsubscribe = null;
    observer?.destroy();
    observer = null;
  };

  let runRangeLoader: () => void = () => undefined;

  const reconcilePageTotals = (): void => {
    const pages = snapshot?.result.data?.pages;
    if (!pages || pages.length < 2) {
      return;
    }

    const pageTotals = new Set(pages.map((page) => page.total));
    if (pageTotals.size < 2 || invalidationPending) {
      return;
    }

    const fingerprint = `${anchorOffset}:${pages[0]?.total}:${pages.at(-1)?.total}`;
    if (fingerprint === invalidationFingerprint) {
      return;
    }

    invalidationFingerprint = fingerprint;
    invalidationPending = true;
    const operation = {};
    invalidationToken = operation;
    void invalidateGalleryItems(queryClient, owner)
      .then(() => {
        if (disposed || invalidationToken !== operation) {
          return;
        }
        invalidationPending = false;
        invalidationToken = null;
        const range = latestRange;
        if (range) {
          pendingRange = range;
          runRangeLoader();
        }
      })
      .catch(() => {
        if (disposed || invalidationToken !== operation) {
          return;
        }
        invalidationPending = false;
        invalidationToken = null;
        invalidationFingerprint = null;
        failedRange = latestRange;
      });
  };

  const startObserver = (maxPages = GALLERY_MAX_INFINITE_PAGES): void => {
    if (disposed || !isOwnerCurrent()) {
      return;
    }

    observer = new InfiniteQueryObserver(queryClient, getObserverOptions(anchorOffset, maxPages)) as GalleryObserver;
    updateSnapshot(observer.getCurrentResult());
  };

  const attachObserver = (): void => {
    if (!observer || observerUnsubscribe || disposed) {
      return;
    }

    const observerGeneration = generation;
    observerUnsubscribe = observer.subscribe((result) => {
      if (disposed || observerGeneration !== generation) {
        return;
      }

      updateSnapshot(result);
      if (pendingRange && !activeOperation) {
        runRangeLoader();
      }
    });
  };

  const setObserverWindow = (offset: number, maxPages: number): void => {
    if (!isOwnerCurrent()) {
      return;
    }
    stopObserver();
    anchorOffset = offset;
    snapshot = null;
    startObserver(maxPages);
    attachObserver();
  };

  runRangeLoader = () => {
    if (disposed || !isOwnerCurrent() || isPaginated || activeOperation || invalidationPending) {
      return;
    }

    const range = pendingRange;
    const currentObserver = observer;
    const currentResult = currentObserver?.getCurrentResult();

    if (!range || !currentObserver || !currentResult) {
      return;
    }

    if (currentResult.isError && !retryRequested) {
      failedRange = latestRange ?? range;
      return;
    }

    if (!currentResult.data) {
      return;
    }

    const requestedPages =
      Math.floor(Math.max(range.first, range.last) / GALLERY_PAGE_SIZE) -
      Math.floor(range.first / GALLERY_PAGE_SIZE) +
      1;
    const maxPages = Math.max(GALLERY_MAX_INFINITE_PAGES, requestedPages + 2);
    const action = getGalleryWindowLoadAction({
      first: range.first,
      last: range.last,
      maxPages,
      pageOffsets: currentResult.data.pageParams,
    });

    if (currentResult.data.pages.length > maxPages && requestedPages <= maxPages) {
      const pageOffsets = currentResult.data.pageParams;
      const startOffset = pageOffsets[0] ?? anchorOffset;
      const endOffset = pageOffsets.at(-1) ?? startOffset;
      const firstRequestedOffset = Math.floor(range.first / GALLERY_PAGE_SIZE) * GALLERY_PAGE_SIZE;
      const lastRequestedOffset = Math.floor(range.last / GALLERY_PAGE_SIZE) * GALLERY_PAGE_SIZE;
      const startIndex =
        firstRequestedOffset < startOffset
          ? 0
          : lastRequestedOffset > endOffset
            ? pageOffsets.length - maxPages
            : Math.min(pageOffsets.indexOf(firstRequestedOffset), pageOffsets.length - maxPages);
      const boundedStart = Math.max(0, startIndex);
      pendingRange = range;
      queryClient.setQueryData<InfiniteData<GalleryItemsPage, number>>(currentObserver.options.queryKey, (data) =>
        data
          ? {
              pageParams: data.pageParams.slice(boundedStart, boundedStart + maxPages),
              pages: data.pages.slice(boundedStart, boundedStart + maxPages),
            }
          : data
      );
      return;
    }

    pendingRange = null;

    if (action.kind === 'none') {
      return;
    }

    if (action.kind === 'reanchor') {
      pendingRange = latestRange ?? range;
      // Returning to the original anchor after eviction still needs a fresh window. The generation suffix keeps
      // a new observer from picking up the old anchor's slid cache before its immediate collection runs.
      setObserverWindow(action.offset, maxPages);
      return;
    }

    if (
      (action.kind === 'next' && !currentResult.hasNextPage) ||
      (action.kind === 'previous' && !currentResult.hasPreviousPage)
    ) {
      return;
    }

    currentObserver.setOptions(getObserverOptions(anchorOffset, maxPages));
    const operation = {};
    const operationGeneration = generation;
    activeOperation = operation;
    retryRequested = false;
    const fetch = action.kind === 'next' ? currentObserver.fetchNextPage : currentObserver.fetchPreviousPage;

    void fetch
      .call(currentObserver, { cancelRefetch: false, throwOnError: true })
      .then((result) => {
        if (disposed || operationGeneration !== generation || activeOperation !== operation) {
          return;
        }

        if (result.isError) {
          failedRange = latestRange ?? range;
          return;
        }

        reconcilePageTotals();
        pendingRange = latestRange;
      })
      .catch(() => {
        if (!disposed && operationGeneration === generation && activeOperation === operation) {
          failedRange = latestRange ?? range;
        }
      })
      .finally(() => {
        if (disposed || operationGeneration !== generation || activeOperation !== operation) {
          return;
        }

        activeOperation = null;
        runRangeLoader();
      });
  };

  const start = (): void => {
    if (!isOwnerCurrent()) {
      return;
    }
    if (disposed) {
      disposed = false;
    }
    if (!observer) {
      startObserver();
    }
    attachObserver();
  };

  const dispose = (): void => {
    if (listeners.size !== 0) {
      return;
    }

    disposed = true;
    pendingRange = null;
    latestRange = null;
    failedRange = null;
    retryRequested = false;
    invalidationPending = false;
    invalidationToken = null;
    stopObserver();
  };

  const getSnapshot = (): GalleryWindowSnapshot => {
    return snapshot!;
  };

  startObserver();

  return {
    getSnapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          dispose();
        }
      };
    },
    loadRange: (first, last) => {
      if (disposed || !isOwnerCurrent()) {
        return;
      }
      const range = normalizeRange(first, last);
      latestRange = range;
      pendingRange = range;
      failedRange = null;
      runRangeLoader();
    },
    retry: () => {
      if (disposed || !isOwnerCurrent()) {
        return;
      }
      const range = failedRange ?? latestRange;
      const currentObserver = observer;
      if (!currentObserver) {
        return;
      }

      failedRange = null;
      retryRequested = true;
      if (range) {
        latestRange = range;
        pendingRange = range;
      }
      const result = currentObserver.getCurrentResult();
      if (result.data) {
        runRangeLoader();
        return;
      }

      void queryClient.resetQueries({ exact: true, queryKey: currentObserver.options.queryKey });
    },
  };
};
