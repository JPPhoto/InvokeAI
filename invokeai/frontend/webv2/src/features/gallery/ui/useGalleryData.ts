import type { GalleryItem } from '@features/gallery/core/items';
import type { GallerySemanticReference } from '@features/gallery/core/semanticImageQuery';
import type { GallerySettings } from '@features/gallery/core/settings';
import type { GalleryBoard, GalleryView, GeneratedImageContract } from '@features/gallery/core/types';

import { compareGalleryItems, legacyGeneratedImageToGalleryItem, toGalleryItemKey } from '@features/gallery/core/items';
import { GALLERY_RECENT_IMAGE_LIMIT } from '@features/gallery/core/recentImages';
import { ALL_READABLE_BOARDS_ID, isDateBoardId } from '@features/gallery/data/backend';
import {
  flattenGalleryItemsData,
  GALLERY_PAGE_SIZE,
  galleryBoardsOptions,
  galleryItemsInfiniteOptions,
  galleryRecentItemsOptions,
  getGalleryListingBoardsQuery,
  type GalleryItemsFilter,
} from '@features/gallery/data/queries';
import { createGalleryWindowRuntime } from '@features/gallery/data/queryCache';
import { parseDateTokens } from '@platform/search/dateTokens';
import { hashKey, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useSyncExternalStore } from 'react';

import { resolveGallerySelectedBoardId } from './galleryStateView';

export interface GalleryData {
  boards: GalleryBoard[];
  filter: GalleryItemsFilter;
  isLoadingItems: boolean;
  /** The resolved board the items were fetched for. */
  selectedBoardId: string;
  items: GalleryItem[] | null;
  /** The current query's failure, or null while it is healthy. */
  queryError: Error | null;
  total: number | null;
  listing: GalleryListing;
}

export interface GalleryListing {
  /** Absolute index of the first retained backend page. */
  offset: number;
  /** Absolute display index of the first retained backend page after the local recent-image overlay. */
  virtualOffset?: number;
  /** Matching backend item count, when known. */
  total: number | null;
  /** Backend count before local recent images are projected into the view. */
  backendTotal?: number | null;
  /** Number of local rows inserted at the absolute listing head, for consumers without the index transform. */
  leadingOverlayCount?: number;
  /** Backend indices for materialized items, independent of any local recent rows. */
  backendIndexByItemKey?: ReadonlyMap<string, number>;
  /** Converts between virtual grid coordinates and backend listing coordinates. */
  getBackendIndexAtDisplayIndex?: (displayIndex: number) => number | undefined;
  getDisplayIndexForBackendIndex?: (backendIndex: number) => number;
  /** Sparse absolute-index map; short cached pages never compact the page after them. */
  itemsByIndex: ReadonlyMap<number, GalleryItem>;
  /** Selection pages use backend coordinates even when visible row indices are shifted by recent items. */
  selectionPageByItemKey?: ReadonlyMap<string, number>;
  /** Selection cursors use exact backend coordinates, including similarity rank. */
  selectionIndexByItemKey?: ReadonlyMap<string, number>;
  loadRange: (first: number, last: number) => void;
  retry: () => void;
  error: Error | null;
}

export const indexGalleryWindowPages = (
  pages: readonly { offset: number; items: readonly GalleryItem[]; itemIndices?: readonly number[] }[],
  indexShift = 0
): ReadonlyMap<number, GalleryItem> => {
  const indexedItems = new Map<number, GalleryItem>();

  for (const page of pages) {
    for (const [itemIndex, item] of page.items.entries()) {
      indexedItems.set((page.itemIndices?.[itemIndex] ?? page.offset + itemIndex) + indexShift, item);
    }
  }

  return indexedItems;
};

export const indexGalleryWindowWithRecentOverlay = ({
  backendTotal,
  knownRecentPositions = new Map(),
  fallbackInsertionIndex = 0,
  orderDir,
  pages,
  recentItems,
}: {
  backendTotal: number | null;
  knownRecentPositions?: ReadonlyMap<string, number>;
  fallbackInsertionIndex?: number;
  orderDir: GalleryItemsFilter['orderDir'];
  pages: readonly { offset: number; items: readonly GalleryItem[]; itemIndices?: readonly number[] }[];
  recentItems: readonly GalleryItem[];
}): {
  backendIndexByItemKey: ReadonlyMap<string, number>;
  getBackendIndexAtDisplayIndex: (displayIndex: number) => number | undefined;
  getDisplayIndexForBackendIndex: (backendIndex: number) => number;
  itemsByIndex: ReadonlyMap<number, GalleryItem>;
  leadingOverlayCount: number;
  overlayDisplayIndices: ReadonlySet<number>;
  selectionPageByItemKey: ReadonlyMap<string, number>;
  selectionIndexByItemKey: ReadonlyMap<string, number>;
  confirmedRecentPositions: ReadonlyMap<string, number>;
} => {
  const backendIndexMap = indexGalleryWindowPages(pages);
  const itemsByIndex = new Map<number, GalleryItem>();
  const backendIndexByItemKey = new Map<string, number>();
  const selectionPageByItemKey = new Map<string, number>();
  const selectionIndexByItemKey = new Map<string, number>();
  const confirmedRecentPositions = new Map<string, number>();
  const backendEntries = [...backendIndexMap.entries()].sort(([a], [b]) => a - b);
  const compare = (a: GalleryItem, b: GalleryItem) => compareGalleryItems(a, b, { orderDir });
  const recentInsertions = recentItems.map((item) => {
    const key = toGalleryItemKey(item);
    const knownPosition = knownRecentPositions.get(key);
    const nextEntryIndex = backendEntries.findIndex(([, backendItem]) => compare(item, backendItem) < 0);
    let candidateIndex: number;
    let isConfirmed = false;

    if (nextEntryIndex >= 0) {
      candidateIndex = backendEntries[nextEntryIndex]?.[0] ?? fallbackInsertionIndex;
      const previousEntryIndex = nextEntryIndex - 1;
      const previousBackendIndex = previousEntryIndex >= 0 ? backendEntries[previousEntryIndex]?.[0] : undefined;
      isConfirmed =
        (previousBackendIndex === undefined && backendEntries[0]?.[0] === 0) ||
        (previousBackendIndex !== undefined && candidateIndex === previousBackendIndex + 1);

      // A row outside the retained window belongs at the corresponding global boundary, not beside the deep
      // window. A later neighboring page can refine this provisional head/tail position.
      if (previousBackendIndex === undefined && candidateIndex > 0) {
        candidateIndex = 0;
      }
    } else if (backendEntries.length > 0) {
      const [lastBackendIndex] = backendEntries.at(-1) ?? [-1, undefined];
      const firstBackendIndex = backendEntries[0]?.[0] ?? 0;
      const reachesListingTail = backendTotal !== null && lastBackendIndex + 1 === backendTotal;

      candidateIndex =
        reachesListingTail || firstBackendIndex > 0 ? (backendTotal ?? lastBackendIndex + 1) : lastBackendIndex + 1;
      isConfirmed = reachesListingTail;
    } else {
      candidateIndex = orderDir === 'DESC' ? 0 : (backendTotal ?? fallbackInsertionIndex);
    }

    const boundedKnownPosition =
      knownPosition === undefined || backendTotal === null ? knownPosition : Math.min(knownPosition, backendTotal);
    let backendIndex = isConfirmed ? candidateIndex : (boundedKnownPosition ?? candidateIndex);

    if (backendTotal !== null) {
      backendIndex = Math.min(backendIndex, backendTotal);
    }

    if (isConfirmed) {
      confirmedRecentPositions.set(key, backendIndex);
    }

    return { backendIndex, item, key };
  });

  // Recent items are ordered independently of backend-page arrival order. Clamp uncertain edge placements so the
  // local overlay remains in that same order until loading the neighboring page reveals an exact insertion rank.
  let previousInsertionIndex = -1;
  for (const insertion of recentInsertions) {
    insertion.backendIndex = Math.max(insertion.backendIndex, previousInsertionIndex);
    previousInsertionIndex = insertion.backendIndex;

    if (confirmedRecentPositions.has(insertion.key)) {
      confirmedRecentPositions.set(insertion.key, insertion.backendIndex);
    }
  }

  const overlayDisplayIndices = new Set<number>();
  const getDisplayIndexForBackendIndex = (backendIndex: number) =>
    backendIndex + recentInsertions.filter((insertion) => insertion.backendIndex <= backendIndex).length;
  let precedingOverlayCount = 0;

  for (const insertion of recentInsertions) {
    const displayIndex = insertion.backendIndex + precedingOverlayCount;
    overlayDisplayIndices.add(displayIndex);
    itemsByIndex.set(displayIndex, insertion.item);
    const lastSelectableBackendIndex = Math.max(0, (backendTotal ?? insertion.backendIndex + 1) - 1);
    selectionPageByItemKey.set(
      insertion.key,
      Math.floor(Math.min(insertion.backendIndex, lastSelectableBackendIndex) / GALLERY_PAGE_SIZE)
    );
    selectionIndexByItemKey.set(insertion.key, Math.min(insertion.backendIndex, lastSelectableBackendIndex));
    precedingOverlayCount += 1;
  }

  for (const [backendIndex, item] of backendEntries) {
    itemsByIndex.set(getDisplayIndexForBackendIndex(backendIndex), item);
    backendIndexByItemKey.set(toGalleryItemKey(item), backendIndex);
    selectionPageByItemKey.set(toGalleryItemKey(item), Math.floor(backendIndex / GALLERY_PAGE_SIZE));
    selectionIndexByItemKey.set(toGalleryItemKey(item), backendIndex);
  }

  const getBackendIndexAtDisplayIndex = (displayIndex: number): number | undefined => {
    if (overlayDisplayIndices.has(displayIndex)) {
      return undefined;
    }

    return displayIndex - [...overlayDisplayIndices].filter((index) => index < displayIndex).length;
  };
  const sortedItemsByIndex = new Map([...itemsByIndex.entries()].sort(([a], [b]) => a - b));

  return {
    backendIndexByItemKey,
    confirmedRecentPositions,
    getBackendIndexAtDisplayIndex,
    getDisplayIndexForBackendIndex,
    itemsByIndex: sortedItemsByIndex,
    leadingOverlayCount: recentInsertions.filter((insertion) => insertion.backendIndex === 0).length,
    overlayDisplayIndices,
    selectionPageByItemKey,
    selectionIndexByItemKey,
  };
};

const EMPTY_BOARDS: GalleryBoard[] = [];

const useGalleryBoards = ({ settings }: { settings: GallerySettings }) => {
  const query = useQuery(galleryBoardsOptions(getGalleryListingBoardsQuery(settings)));

  return { boards: query.data ?? EMPTY_BOARDS };
};

const isRecentItemVisible = (item: GalleryItem, filter: GalleryItemsFilter): boolean => {
  // Overlay recents only in the unstarred listing; newly starred recents belong to the strip.
  if (
    filter.searchTerm !== '' ||
    filter.createdFrom !== undefined ||
    filter.createdTo !== undefined ||
    filter.starred === true ||
    (filter.starred === false && item.starred) ||
    Boolean(filter.semanticQuery) ||
    isDateBoardId(filter.boardId)
  ) {
    return false;
  }

  const hasMatchingBoard = filter.boardId === ALL_READABLE_BOARDS_ID || filter.boardId === item.boardId;
  const hasMatchingCategory =
    filter.galleryView === 'images'
      ? item.category === 'general'
      : item.kind === 'image' && item.category !== 'general';

  return hasMatchingBoard && hasMatchingCategory;
};

const getRecentGalleryItemsMissingFromWindow = ({
  backendItems,
  filter,
  recentImages,
}: {
  backendItems: readonly GalleryItem[];
  filter: GalleryItemsFilter;
  recentImages: readonly GeneratedImageContract[];
}): GalleryItem[] => {
  const backendItemKeys = new Set(backendItems.map(toGalleryItemKey));

  return recentImages
    .slice(0, GALLERY_RECENT_IMAGE_LIMIT)
    .map(legacyGeneratedImageToGalleryItem)
    .filter((item) => !backendItemKeys.has(toGalleryItemKey(item)) && isRecentItemVisible(item, filter))
    .sort((a, b) => compareGalleryItems(a, b, { orderDir: filter.orderDir }));
};

const createRecentReconciliationStore = (identityQueryKey: string) => {
  const listeners = new Set<() => void>();
  let snapshot = { identityQueryKey, positions: new Map<string, number>() };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const update = (
    recentItemKeys: ReadonlySet<string>,
    backendItems: readonly GalleryItem[],
    confirmedRecentPositions: ReadonlyMap<string, number>,
    persistedRecentKeys: ReadonlySet<string>
  ) => {
    const backendItemKeys = new Set<string>(backendItems.map(toGalleryItemKey));
    const knownRecentKeys = new Set([...backendItemKeys, ...persistedRecentKeys]);
    const positions = new Map(
      [...snapshot.positions].filter(([key]) => recentItemKeys.has(key) && !knownRecentKeys.has(key))
    );

    for (const [key, position] of confirmedRecentPositions) {
      if (recentItemKeys.has(key) && !knownRecentKeys.has(key)) {
        positions.set(key, position);
      }
    }

    const samePositions =
      positions.size === snapshot.positions.size &&
      [...positions].every(([key, position]) => snapshot.positions.get(key) === position);

    if (samePositions) {
      return;
    }

    snapshot = { identityQueryKey, positions };
    listeners.forEach((listener) => listener());
  };

  return { getSnapshot: () => snapshot, subscribe, update };
};

export const mergeGalleryItemWindow = ({
  backendItems,
  filter,
  recentImages,
}: {
  backendItems: readonly GalleryItem[];
  filter: GalleryItemsFilter;
  recentImages: readonly GeneratedImageContract[];
}): GalleryItem[] => {
  const missingRecentItems = getRecentGalleryItemsMissingFromWindow({ backendItems, filter, recentImages });
  const seenItemKeys = new Set<string>();

  const mergedItems = [...missingRecentItems, ...backendItems].filter((item) => {
    const key = toGalleryItemKey(item);

    if (seenItemKeys.has(key)) {
      return false;
    }

    seenItemKeys.add(key);
    return true;
  });

  // Semantic results arrive in relevance order, which a date re-sort would
  // destroy; the backend order is the meaning of the list. (No recent items
  // are overlaid in that mode, so the merge is the backend window itself.)
  if (!filter.semanticQuery) {
    mergedItems.sort((a, b) => compareGalleryItems(a, b, { orderDir: filter.orderDir }));
  }

  return mergedItems;
};

export const useGalleryData = ({
  galleryView,
  page,
  projectBoardId,
  recentImages,
  searchTerm,
  selectedBoardId,
  semanticQuery = null,
  settings,
  starred,
}: {
  galleryView: GalleryView;
  page: number;
  projectBoardId: string | null;
  recentImages: readonly GeneratedImageContract[];
  searchTerm: string;
  selectedBoardId: string | null;
  /** When set, items come from semantic search (similarity order) instead of the board listing. */
  semanticQuery?: GallerySemanticReference | null;
  settings: GallerySettings;
  /**
   * Partition to list: the grid asks for unstarred (`false`) or, under its
   * starred filter, starred (`true`); consumers like the picker omit it and
   * see everything.
   */
  starred?: boolean;
}): GalleryData => {
  const consumerId = useId();
  const queryClient = useQueryClient();
  const { boards } = useGalleryBoards({ settings });
  const boardId = resolveGallerySelectedBoardId({ projectBoardId, selectedBoardId }, boards);
  const isPaginated = settings.paginationMode === 'paginated';
  const dateParse = useMemo(() => parseDateTokens(searchTerm), [searchTerm]);
  const filter = useMemo<GalleryItemsFilter>(
    () => ({
      boardId,
      createdFrom: dateParse.range?.from,
      createdTo: dateParse.range?.to,
      galleryView,
      orderDir: settings.imageOrderDir,
      searchTerm: dateParse.text,
      ...(semanticQuery ? { semanticQuery } : {}),
      ...(starred !== undefined ? { starred } : {}),
    }),
    [
      boardId,
      dateParse.range?.from,
      dateParse.range?.to,
      dateParse.text,
      galleryView,
      semanticQuery,
      settings.imageOrderDir,
      starred,
    ]
  );
  const identityOptions = galleryItemsInfiniteOptions(filter, { kind: 'infinite', offset: 0 }, consumerId);
  const identityQueryKey = hashKey(identityOptions.queryKey.slice(0, 5));
  const runtime = useMemo(
    () =>
      createGalleryWindowRuntime({
        consumerId: `${consumerId}:${identityQueryKey}`,
        filter,
        initialOffset: page * GALLERY_PAGE_SIZE,
        isPaginated,
        queryClient,
      }),
    [consumerId, filter, identityQueryKey, isPaginated, page, queryClient]
  );
  const runtimeSnapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const queryData = runtimeSnapshot.result.data;
  const isFetching = runtimeSnapshot.result.isFetching;
  const requestedAnchorOffset = isPaginated ? page * GALLERY_PAGE_SIZE : runtimeSnapshot.offset;
  const backendItems = useMemo(() => {
    if (!isPaginated) {
      return flattenGalleryItemsData(queryData);
    }

    const pageOffset = requestedAnchorOffset;
    const pageIndex = queryData?.pageParams.indexOf(pageOffset) ?? -1;

    return pageIndex === -1 ? [] : (queryData?.pages[pageIndex]?.items ?? []).slice(0, GALLERY_PAGE_SIZE);
  }, [isPaginated, queryData, requestedAnchorOffset]);
  const recentItemKeys = useMemo(
    () => new Set(recentImages.slice(0, GALLERY_RECENT_IMAGE_LIMIT).map((image) => `image:${image.imageName}`)),
    [recentImages]
  );
  const reconciledRecentStore = useMemo(() => createRecentReconciliationStore(identityQueryKey), [identityQueryKey]);
  const reconciledRecentSnapshot = useSyncExternalStore(
    reconciledRecentStore.subscribe,
    reconciledRecentStore.getSnapshot,
    reconciledRecentStore.getSnapshot
  );
  const recentCandidates = useMemo(
    () => getRecentGalleryItemsMissingFromWindow({ backendItems, filter, recentImages }),
    [backendItems, filter, recentImages]
  );
  const recentNamesToResolve = useMemo(() => recentCandidates.map((item) => item.name), [recentCandidates]);
  const recentMembershipQuery = useQuery({
    ...galleryRecentItemsOptions(recentNamesToResolve),
    enabled: !isPaginated && recentNamesToResolve.length > 0,
  });
  const recentMembershipError = recentMembershipQuery.error ?? null;
  const isRecentMembershipResolved =
    recentMembershipQuery.isSuccess && !recentMembershipQuery.isFetching && recentMembershipError === null;
  const queryError = runtimeSnapshot.result.error ?? recentMembershipError;
  const persistedRecentKeys = useMemo(
    () => new Set((recentMembershipQuery.data ?? []).map(toGalleryItemKey)),
    [recentMembershipQuery.data]
  );
  const knownRecentKeys = useMemo(
    () => new Set([...backendItems.map(toGalleryItemKey), ...persistedRecentKeys]),
    [backendItems, persistedRecentKeys]
  );
  const overlayRecentImages = useMemo(
    () =>
      !isPaginated && isRecentMembershipResolved
        ? recentImages.filter((image) => !knownRecentKeys.has(`image:${image.imageName}`))
        : [],
    [isPaginated, isRecentMembershipResolved, knownRecentKeys, recentImages]
  );
  const recentOverlayItems = useMemo(
    () =>
      isRecentMembershipResolved ? recentCandidates.filter((item) => !knownRecentKeys.has(toGalleryItemKey(item))) : [],
    [isRecentMembershipResolved, knownRecentKeys, recentCandidates]
  );
  const offset = runtimeSnapshot.offset;
  const displayTotal = runtimeSnapshot.total === null ? null : runtimeSnapshot.total + recentOverlayItems.length;
  const indexedWindow = useMemo(
    () =>
      indexGalleryWindowWithRecentOverlay({
        backendTotal: runtimeSnapshot.total,
        fallbackInsertionIndex: requestedAnchorOffset,
        knownRecentPositions: reconciledRecentSnapshot.positions,
        orderDir: filter.orderDir,
        pages: (queryData?.pages ?? []).map((pageData, pageIndex) => ({
          offset: queryData?.pageParams[pageIndex] ?? offset + pageIndex * GALLERY_PAGE_SIZE,
          ...(pageData.itemIndices ? { itemIndices: pageData.itemIndices } : {}),
          items: pageData.items,
        })),
        recentItems: recentOverlayItems,
      }),
    [
      filter.orderDir,
      offset,
      queryData,
      recentOverlayItems,
      reconciledRecentSnapshot.positions,
      requestedAnchorOffset,
      runtimeSnapshot.total,
    ]
  );
  const { itemsByIndex, selectionIndexByItemKey, selectionPageByItemKey } = indexedWindow;
  const leadingOverlayCount = indexedWindow.leadingOverlayCount;
  const virtualOffset = indexedWindow.getDisplayIndexForBackendIndex(requestedAnchorOffset);
  useEffect(() => {
    if (!isPaginated) {
      reconciledRecentStore.update(
        recentItemKeys,
        backendItems,
        indexedWindow.confirmedRecentPositions,
        persistedRecentKeys
      );
    }
  }, [
    backendItems,
    indexedWindow.confirmedRecentPositions,
    isPaginated,
    persistedRecentKeys,
    recentItemKeys,
    reconciledRecentStore,
  ]);
  const loadRange = useMemo(() => {
    const backendTotal = runtimeSnapshot.total;

    return (first: number, last: number) => {
      if (last < first) {
        return;
      }

      const overlayIndices = [...indexedWindow.overlayDisplayIndices];
      const overlayBeforeFirst = overlayIndices.filter((index) => index < first).length;
      const overlayThroughLast = overlayIndices.filter((index) => index <= last).length;
      const backendFirst = first - overlayBeforeFirst;
      const backendLast = last - overlayThroughLast;

      // A range containing only local overlay rows has no backend page to request.
      if (backendLast < backendFirst) {
        return;
      }

      if (backendLast < 0 || (backendTotal !== null && backendFirst >= backendTotal)) {
        return;
      }

      runtime.loadRange(
        Math.max(0, backendFirst),
        backendTotal === null ? backendLast : Math.min(backendTotal - 1, backendLast)
      );
    };
  }, [indexedWindow, runtime, runtimeSnapshot.total]);
  const items = useMemo(() => {
    if (!queryData && backendItems.length === 0 && recentOverlayItems.length === 0) {
      return null;
    }

    return mergeGalleryItemWindow({
      backendItems,
      filter,
      recentImages: overlayRecentImages,
    });
  }, [backendItems, filter, overlayRecentImages, queryData, recentOverlayItems.length]);
  const total = displayTotal;
  return {
    boards,
    filter,
    isLoadingItems: isFetching || recentMembershipQuery.isFetching,
    items,
    queryError,
    selectedBoardId: boardId,
    total,
    listing: {
      offset,
      virtualOffset,
      total,
      backendTotal: runtimeSnapshot.total,
      leadingOverlayCount,
      backendIndexByItemKey: indexedWindow.backendIndexByItemKey,
      getBackendIndexAtDisplayIndex: indexedWindow.getBackendIndexAtDisplayIndex,
      getDisplayIndexForBackendIndex: indexedWindow.getDisplayIndexForBackendIndex,
      itemsByIndex,
      selectionPageByItemKey,
      selectionIndexByItemKey,
      loadRange,
      retry: () => {
        runtime.retry();

        if (recentMembershipError !== null) {
          void recentMembershipQuery.refetch();
        }
      },
      error: queryError,
    },
  };
};
