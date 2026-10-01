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
  getGalleryListingBoardsQuery,
  type GalleryItemsFilter,
} from '@features/gallery/data/queries';
import { createGalleryWindowRuntime } from '@features/gallery/data/queryCache';
import { parseDateTokens } from '@platform/search/dateTokens';
import { hashKey, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useSyncExternalStore } from 'react';

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
  /** Matching backend item count, when known. */
  total: number | null;
  /** Sparse absolute-index map; short cached pages never compact the page after them. */
  itemsByIndex: ReadonlyMap<number, GalleryItem>;
  loadRange: (first: number, last: number) => void;
  retry: () => void;
  error: Error | null;
}

export const indexGalleryWindowPages = (
  pages: readonly { offset: number; items: readonly GalleryItem[]; itemIndices?: readonly number[] }[]
): ReadonlyMap<number, GalleryItem> => {
  const indexedItems = new Map<number, GalleryItem>();

  for (const page of pages) {
    for (const [itemIndex, item] of page.items.entries()) {
      indexedItems.set(page.itemIndices?.[itemIndex] ?? page.offset + itemIndex, item);
    }
  }

  return indexedItems;
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

export const mergeGalleryItemWindow = ({
  backendItems,
  filter,
  recentImages,
}: {
  backendItems: readonly GalleryItem[];
  filter: GalleryItemsFilter;
  recentImages: readonly GeneratedImageContract[];
}): GalleryItem[] => {
  const backendItemKeys = new Set(backendItems.map(toGalleryItemKey));
  const missingRecentItems = recentImages
    .slice(0, GALLERY_RECENT_IMAGE_LIMIT)
    .map(legacyGeneratedImageToGalleryItem)
    .filter((item) => !backendItemKeys.has(toGalleryItemKey(item)) && isRecentItemVisible(item, filter));
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
  const queryError = runtimeSnapshot.result.error;
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
  // Recents belong at the top of the listing; overlaying them onto a window
  // anchored mid-board would sort them into a part of the list they are
  // nowhere near.
  const shouldOverlayRecentItems = !isPaginated && requestedAnchorOffset === 0;
  const optimisticRecentItems = useMemo(
    () =>
      !isPaginated && shouldOverlayRecentItems && !queryData
        ? mergeGalleryItemWindow({ backendItems: [], filter, recentImages })
        : [],
    [filter, isPaginated, queryData, recentImages, shouldOverlayRecentItems]
  );
  const items = useMemo(() => {
    if (!queryData && optimisticRecentItems.length === 0) {
      return null;
    }

    if (!isPaginated) {
      // Once the first backend page arrives it owns listing positions. Realtime invalidation then reconciles any
      // optimistic completion with the authoritative ordered page.
      return queryData ? backendItems : optimisticRecentItems;
    }

    return mergeGalleryItemWindow({
      backendItems,
      filter,
      recentImages: shouldOverlayRecentItems ? recentImages : [],
    });
  }, [backendItems, filter, isPaginated, optimisticRecentItems, queryData, recentImages, shouldOverlayRecentItems]);
  const total = runtimeSnapshot.total;
  const offset = runtimeSnapshot.offset;
  const itemsByIndex = useMemo(() => {
    if (!queryData && optimisticRecentItems.length > 0) {
      return indexGalleryWindowPages([{ offset: 0, items: optimisticRecentItems }]);
    }

    return indexGalleryWindowPages(
      (queryData?.pages ?? []).map((pageData, pageIndex) => ({
        offset: queryData?.pageParams[pageIndex] ?? offset + pageIndex * GALLERY_PAGE_SIZE,
        ...(pageData.itemIndices ? { itemIndices: pageData.itemIndices } : {}),
        items: pageData.items,
      }))
    );
  }, [offset, optimisticRecentItems, queryData]);
  return {
    boards,
    filter,
    isLoadingItems: isFetching,
    items,
    queryError,
    selectedBoardId: boardId,
    total,
    listing: {
      offset,
      total,
      itemsByIndex,
      loadRange: runtime.loadRange,
      retry: runtime.retry,
      error: queryError,
    },
  };
};
