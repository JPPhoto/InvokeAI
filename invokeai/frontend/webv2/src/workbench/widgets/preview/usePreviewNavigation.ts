import type { GalleryImageItem, GalleryItem, GalleryItemKey, GalleryItemRef, GalleryView } from '@features/gallery';
import type {
  GalleryItemsPage,
  GalleryNavigationEntry,
  GallerySelectionCursor,
  GallerySemanticReference,
  getGallerySelectedImageQuery,
} from '@features/gallery/contracts';
import type { GalleryItemsFilter, GalleryItemsWindow } from '@features/gallery/queries';
import type { QueueItem, QueueProgressSession } from '@features/queue/contracts';
import type { InfiniteData } from '@tanstack/react-query';
import type { KeyboardEvent } from 'react';

import {
  GALLERY_RECENT_IMAGE_LIMIT,
  compareGalleryItems,
  getGalleryNavigationStep,
  getGallerySessionNavigationKey,
  resolveGallerySelectionCursor,
  toGalleryItemKey,
} from '@features/gallery/contracts';
import {
  flattenGalleryItemsData,
  GALLERY_MAX_ROWS,
  GALLERY_PAGE_SIZE,
  galleryItemsInfiniteOptions,
  galleryItemNamesOptions,
  getGalleryListingIdentity,
  galleryStarredStripOptions,
} from '@features/gallery/queries';
import { parseDateTokens } from '@platform/search/dateTokens';
import { hashKey, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * Own Preview query merging, cursor derivation, boundary fetches, and neighbor prefetch. Follow Gallery's
 * session/starred/list order, but traverse the full bounded starred query beyond the grid's folded rows;
 * selection/follow remain authoritative.
 */

const EMPTY_PREVIEW_ITEMS: GalleryItem[] = [];
const MAX_PREVIEW_BOARD_ITEMS = GALLERY_MAX_ROWS + GALLERY_RECENT_IMAGE_LIMIT;

const flattenPreviewItems = (data: InfiniteData<GalleryItemsPage, number> | undefined): GalleryItem[] =>
  flattenGalleryItemsData(data);

const getOrderedPreviewItems = (
  items: GalleryItem[],
  imageOrderDir: 'ASC' | 'DESC',
  inputOrder: 'display' | 'newest-first'
): GalleryItem[] =>
  items
    .map((item, index) => ({ index, item }))
    .sort((a, b) => {
      const canonicalOrder = compareGalleryItems(a.item, b.item, { orderDir: imageOrderDir });

      if (canonicalOrder !== 0) {
        return canonicalOrder;
      }

      return inputOrder === 'newest-first' && imageOrderDir === 'ASC' ? b.index - a.index : a.index - b.index;
    })
    .map(({ item }) => item);

/**
 * Which gallery tab an item belongs to. Mirrors the category split the
 * gallery filters on: `general` is a gallery image, everything else (canvas
 * pixels, control layers, uploads) is an asset.
 */
const getItemGalleryView = (item: GalleryItem): GalleryView => (item.category === 'general' ? 'images' : 'assets');

const getOrderedLocalItems = ({
  boardId,
  galleryView,
  items,
  imageOrderDir,
}: {
  boardId: string;
  galleryView: GalleryView;
  items: GalleryItem[];
  imageOrderDir: 'ASC' | 'DESC';
}): GalleryItem[] =>
  getOrderedPreviewItems(
    items.filter((item) => item.boardId === boardId && getItemGalleryView(item) === galleryView),
    imageOrderDir,
    'newest-first'
  );

export const mergePreviewBoardItems = (
  backendItems: GalleryItem[],
  localItems: GalleryItem[],
  imageOrderDir: 'ASC' | 'DESC',
  { isRanked = false }: { isRanked?: boolean } = {}
): GalleryItem[] => {
  const backendKeys = new Set(backendItems.map(toGalleryItemKey));

  // Preserve ranking order and exclude local generations; retain out-of-ranking selection as a cursor anchor so
  // arrows remain usable.
  if (isRanked) {
    const anchors = localItems.filter((item) => !backendKeys.has(toGalleryItemKey(item)));

    return [...anchors, ...backendItems].slice(0, MAX_PREVIEW_BOARD_ITEMS);
  }

  const missingLocalItems = localItems.filter((item) => !backendKeys.has(toGalleryItemKey(item)));

  if (missingLocalItems.length === 0) {
    return backendItems.slice(0, MAX_PREVIEW_BOARD_ITEMS);
  }

  return getOrderedPreviewItems([...backendItems, ...missingLocalItems], imageOrderDir, 'display').slice(
    0,
    MAX_PREVIEW_BOARD_ITEMS
  );
};

const toItemEntries = (items: readonly GalleryItem[]): GalleryNavigationEntry[] =>
  items.map((item) => ({ item, kind: 'item' }));

/**
 * A step's destination: a saved item, a running session, a page not loaded yet (`more`), or nothing (null).
 */
export type PreviewNeighbor =
  | { kind: 'item'; item: GalleryItem }
  | { kind: 'more' }
  | { kind: 'session'; id: string }
  | null;

export interface PreviewNeighbors {
  next: PreviewNeighbor;
  previous: PreviewNeighbor;
}

const NO_NEIGHBORS: PreviewNeighbors = { next: null, previous: null };

const toNeighbor = (entry: GalleryNavigationEntry | null): PreviewNeighbor =>
  entry === null
    ? null
    : entry.kind === 'item'
      ? { item: entry.item, kind: 'item' }
      : { id: entry.id, kind: 'session' };

export interface PreviewNavigationState {
  /** Every saved item the arrows can reach, in order: the starred strip, then the listing. */
  boardItems: GalleryItem[];
  handleNavigationKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  isLoadingBoard: boolean;
  /** Resolves true once a step was dispatched; false when there was nowhere to go or the step went stale. */
  navigate: (offset: -1 | 1) => Promise<boolean>;
  /** What each step would land on, so a swipe can show it before committing. */
  neighbors: PreviewNeighbors;
  /** The selection's index in `boardItems`; -1 while following live or off the list. */
  navigationCursor: number;
  /** Identity of the backing query — the action context's filter identity. */
  navigationQueryKey: string;
  /** The page a selection of `item` is stamped with — see the action context's `getItemSelectionPage`. */
  getSelectionPage: (item: GalleryItem) => number;
  getSelectionCursor: (item: GalleryItem) => GallerySelectionCursor | null;
  getSelectionPageAfterRemoval: (
    item: GalleryItem,
    orderedRefs: GalleryItemRef[],
    removedRefs: GalleryItemRef[]
  ) => number;
  selectPreviewItem: (item: GalleryItem) => void;
}

export const usePreviewNavigation = ({
  followedSessionId,
  followSession,
  isComparing,
  localItems,
  progressSessions,
  queueItems,
  galleryBoardId,
  selectGalleryItem,
  selectedImageQuery,
  selectedItem,
  selectedItemKey,
  semanticQuery,
}: {
  /** The live session on screen, when the preview is following one; the cursor sits on it. */
  followedSessionId: string | null;
  followSession: (sessionId: string) => void;
  /** The board the gallery grid shows; a ranked list ranks within it, as the grid does. */
  galleryBoardId: string;
  isComparing: boolean;
  /** Recent local generations, already normalized to gallery items. */
  localItems: GalleryImageItem[];
  /** The gallery's in-progress tiles, in its order; only running ones can be stepped onto. */
  progressSessions: readonly QueueProgressSession[];
  queueItems: QueueItem[];
  selectGalleryItem: (item: GalleryItem, selectionPage: number, cursor: GallerySelectionCursor | null) => void;
  selectedImageQuery: ReturnType<typeof getGallerySelectedImageQuery>;
  selectedItem: GalleryItem | null;
  selectedItemKey: GalleryItemKey | null;
  /** The gallery's active similarity search, or null for the board listing. */
  semanticQuery: GallerySemanticReference | null;
}): PreviewNavigationState => {
  const selectedImageSearch = useMemo(
    () => parseDateTokens(selectedImageQuery.searchTerm),
    [selectedImageQuery.searchTerm]
  );
  // A ranked filmstrip follows the gallery's current search, board and paging; a listing follows the selection's.
  const navigationBoardId = semanticQuery ? galleryBoardId : selectedImageQuery.boardId;
  const navigationGalleryView = selectedImageQuery.galleryView;
  const navigationOrderDir = selectedImageQuery.imageOrderDir;
  // The grid partitions: its listing is unstarred-only, with the starred
  // items in the strip above it, unless the starred filter is on.
  const navigationStarredOnly = selectedImageQuery.starredOnly;
  const navigationSemanticQuery = semanticQuery;
  const listingFilter = useMemo(
    (): GalleryItemsFilter => ({
      boardId: navigationBoardId,
      createdFrom: selectedImageSearch.range?.from,
      createdTo: selectedImageSearch.range?.to,
      galleryView: navigationGalleryView,
      orderDir: navigationOrderDir,
      searchTerm: selectedImageSearch.text,
      ...(navigationSemanticQuery ? { semanticQuery: navigationSemanticQuery } : {}),
    }),
    [navigationBoardId, navigationGalleryView, navigationOrderDir, navigationSemanticQuery, selectedImageSearch]
  );
  const navigationListingId = getGalleryListingIdentity({ ...listingFilter, starred: navigationStarredOnly });
  const savedCursor = selectedImageQuery.cursor;
  const savedCursorMatchesListing =
    savedCursor !== undefined &&
    savedCursor.listingId === navigationListingId &&
    savedCursor.itemKey === selectedItemKey;
  // Following live has a cursor too, so the listing loads for the step off it.
  const hasNavigationContext = selectedItem !== null || followedSessionId !== null;
  const navigationContextKey = `${followedSessionId ?? ''}:${selectedItemKey ?? ''}:${navigationListingId}:${savedCursor?.section ?? ''}:${savedCursor?.index ?? ''}`;
  const navigationQueryKey = `${navigationListingId}:${selectedImageQuery.paginationMode}`;

  // Publish navigation context in layout effect so boundary-fetch continuations cannot observe new UI with a stale
  // fence.
  const navigationContextKeyRef = useRef(navigationContextKey);

  useLayoutEffect(() => {
    navigationContextKeyRef.current = navigationContextKey;
  }, [navigationContextKey]);

  // Keep navigation windows anchored until the query identity changes. Infinite selections carry their actual
  // backend page, so the query must not rekey on every Preview step; the window slides around this anchor instead.
  const initialAnchorPage =
    savedCursorMatchesListing && savedCursor?.section === 'listing'
      ? Math.floor(savedCursor.index / GALLERY_PAGE_SIZE)
      : savedCursor !== undefined
        ? 0
        : navigationSemanticQuery !== null
          ? 0
          : selectedImageQuery.page;
  const [navigationAnchor, setNavigationAnchor] = useState({
    page: initialAnchorPage,
    queryKey: navigationQueryKey,
    reanchorContextKey: null as string | null,
    revision: 0,
  });
  const hasStaleNavigationAnchor = navigationAnchor.queryKey !== navigationQueryKey;

  if (hasStaleNavigationAnchor) {
    setNavigationAnchor({
      page: initialAnchorPage,
      queryKey: navigationQueryKey,
      reanchorContextKey: null,
      revision: 0,
    });
  }

  const navigationAnchorPage = hasStaleNavigationAnchor ? initialAnchorPage : navigationAnchor.page;
  const navigationAnchorRevision = hasStaleNavigationAnchor ? 0 : navigationAnchor.revision;
  const isPaginatedWindow = selectedImageQuery.paginationMode === 'paginated';
  const navigationAnchorOffset = navigationAnchorPage * GALLERY_PAGE_SIZE;

  const navigationWindow = useMemo(
    (): GalleryItemsWindow =>
      isPaginatedWindow
        ? { kind: 'anchor', offset: navigationAnchorOffset }
        : { kind: 'infinite', offset: navigationAnchorOffset },
    [isPaginatedWindow, navigationAnchorOffset]
  );

  const queryClient = useQueryClient();
  const navigationItemsOptions = galleryItemsInfiniteOptions(
    { ...listingFilter, starred: navigationStarredOnly },
    navigationWindow,
    navigationAnchorRevision > 0 ? `preview-reanchor:${navigationAnchorRevision}` : undefined
  );
  const navigationItemsKeyHash = hashKey(navigationItemsOptions.queryKey);
  const previousNavigationItemsKeyHashRef = useRef(navigationItemsKeyHash);

  // Preview keeps the current window cached while its Activity is hidden so the filmstrip can restore its scroll
  // position. Reanchoring removes the previous inactive window, keeping Preview's retained page data bounded.
  useEffect(() => {
    const previousKeyHash = previousNavigationItemsKeyHashRef.current;

    if (previousKeyHash !== navigationItemsKeyHash) {
      previousNavigationItemsKeyHashRef.current = navigationItemsKeyHash;
      // Let useInfiniteQuery detach from the old entry before checking that it is inactive.
      queueMicrotask(() => {
        const previousQuery = queryClient.getQueryCache().get(previousKeyHash);

        if (previousQuery) {
          queryClient.removeQueries({ exact: true, queryKey: previousQuery.queryKey, type: 'inactive' });
        }
      });
    }
  }, [navigationItemsKeyHash, queryClient]);

  const {
    data: boardItemsData,
    fetchNextPage: fetchNextBoardItemsPage,
    fetchPreviousPage: fetchPreviousBoardItemsPage,
    hasNextPage: hasNextBoardItemsPage,
    hasPreviousPage: hasPreviousBoardItemsPage,
    isFetching: isFetchingBoardItems,
    isStale: isListingStale,
    isFetchingNextPage: isFetchingNextBoardItemsPage,
    isFetchingPreviousPage: isFetchingPreviousBoardItemsPage,
  } = useInfiniteQuery({ ...navigationItemsOptions, enabled: hasNavigationContext });
  const isListingInvalidated =
    isListingStale && (queryClient.getQueryState(navigationItemsOptions.queryKey)?.isInvalidated ?? false);
  const selectedItemInWindow =
    selectedItemKey !== null &&
    (boardItemsData?.pages.some((page) => page.items.some((item) => toGalleryItemKey(item) === selectedItemKey)) ??
      false);
  // Share Gallery's bounded starred strip except for ranked, starred-only, or mid-board windows.
  const hasTopPage = boardItemsData?.pageParams.includes(0) ?? navigationAnchorOffset === 0;
  const hasStrip = hasNavigationContext && !navigationStarredOnly && navigationSemanticQuery === null && hasTopPage;
  const {
    data: stripData,
    isFetching: isFetchingStrip,
    isStale: isStripStale,
    isSuccess: hasLoadedStrip,
  } = useQuery({
    ...galleryStarredStripOptions(listingFilter),
    enabled: hasStrip,
  });
  const queriedStripItems = hasStrip ? (stripData?.items ?? EMPTY_PREVIEW_ITEMS) : EMPTY_PREVIEW_ITEMS;
  const selectedStripIndex = queriedStripItems.findIndex((item) => toGalleryItemKey(item) === selectedItemKey);
  const stripPositionIsCurrent = !hasStrip || (hasLoadedStrip && !isFetchingStrip && !isStripStale);
  const savedStripCursorWasRemoved =
    savedCursorMatchesListing &&
    savedCursor?.section === 'starred-strip' &&
    stripPositionIsCurrent &&
    selectedStripIndex < 0;
  const shouldResolveSelection =
    hasNavigationContext &&
    selectedItemKey !== null &&
    (!savedCursorMatchesListing ||
      (savedCursor?.section === 'listing' && boardItemsData !== undefined && !selectedItemInWindow) ||
      savedStripCursorWasRemoved);
  const orderedNamesQuery = useQuery({
    ...galleryItemNamesOptions({ ...listingFilter, starred: navigationStarredOnly }),
    enabled: shouldResolveSelection,
  });

  const getSelectionIndexIn = useCallback((item: GalleryItem, data: typeof boardItemsData): number | undefined => {
    const itemKey = toGalleryItemKey(item);
    const pageIndex = data?.pages.findIndex((page) =>
      page.items.some((candidate) => toGalleryItemKey(candidate) === itemKey)
    );
    const page = pageIndex === undefined || pageIndex < 0 ? undefined : data?.pages[pageIndex];
    const pageParam = pageIndex === undefined || pageIndex < 0 ? undefined : data?.pageParams[pageIndex];
    const itemIndex = page?.items.findIndex((candidate) => toGalleryItemKey(candidate) === itemKey);

    return typeof pageParam === 'number' && itemIndex !== undefined && itemIndex >= 0
      ? (page?.itemIndices?.[itemIndex] ?? pageParam + itemIndex)
      : undefined;
  }, []);
  const getLocalListingIndexIn = useCallback(
    (item: GalleryItem, data: typeof boardItemsData): number | undefined => {
      const itemKey = toGalleryItemKey(item);
      const hasLocalItem = localItems.some((candidate) => toGalleryItemKey(candidate) === itemKey);
      const startsAtListingHead = data?.pageParams[0] === 0;
      const hasListingFilters =
        navigationSemanticQuery !== null ||
        navigationStarredOnly ||
        selectedImageSearch.text !== '' ||
        selectedImageSearch.range !== undefined;

      if (!hasLocalItem || !startsAtListingHead || hasListingFilters) {
        return undefined;
      }

      const visibleLocalItems = getOrderedLocalItems({
        boardId: navigationBoardId,
        galleryView: navigationGalleryView,
        items: localItems,
        imageOrderDir: navigationOrderDir,
      });
      const mergedItems = mergePreviewBoardItems(flattenPreviewItems(data), visibleLocalItems, navigationOrderDir);
      const index = mergedItems.findIndex((candidate) => toGalleryItemKey(candidate) === itemKey);

      return index >= 0 ? index : undefined;
    },
    [
      localItems,
      navigationBoardId,
      navigationGalleryView,
      navigationOrderDir,
      navigationSemanticQuery,
      navigationStarredOnly,
      selectedImageSearch,
    ]
  );
  const selectedListingIndex = selectedItem ? getSelectionIndexIn(selectedItem, boardItemsData) : undefined;
  const namedSelectionIndex = orderedNamesQuery.data?.items.findIndex(
    (itemRef) => toGalleryItemKey(itemRef) === selectedItemKey
  );
  const selectedLocalListingIndex =
    selectedItem &&
    orderedNamesQuery.isSuccess &&
    !orderedNamesQuery.isFetching &&
    !orderedNamesQuery.isStale &&
    namedSelectionIndex === -1
      ? getLocalListingIndexIn(selectedItem, boardItemsData)
      : undefined;
  const namedPositionIsCurrent =
    orderedNamesQuery.isSuccess &&
    !orderedNamesQuery.isFetching &&
    !orderedNamesQuery.isStale &&
    namedSelectionIndex !== undefined;
  const resolvedCursor =
    selectedItem && selectedItemKey !== null
      ? resolveGallerySelectionCursor({
          itemKey: selectedItemKey,
          listingId: navigationListingId,
          listingIndex:
            selectedListingIndex ??
            (namedPositionIsCurrent && namedSelectionIndex >= 0 ? namedSelectionIndex : selectedLocalListingIndex),
          savedCursor: savedCursorMatchesListing && !savedStripCursorWasRemoved ? savedCursor : null,
          starredStripIndex: stripPositionIsCurrent && selectedStripIndex >= 0 ? selectedStripIndex : undefined,
        })
      : null;
  const resolvedSelectionPage =
    resolvedCursor?.section === 'starred-strip'
      ? 0
      : resolvedCursor
        ? Math.floor(resolvedCursor.index / GALLERY_PAGE_SIZE)
        : savedCursor !== undefined && !savedCursorMatchesListing
          ? 0
          : selectedImageQuery.page;
  const selectedPageIsLoaded = boardItemsData?.pageParams.some(
    (pageParam) => Math.floor(pageParam / GALLERY_PAGE_SIZE) === resolvedSelectionPage
  );
  const selectionPositionIsCurrent =
    (selectedListingIndex !== undefined && !isFetchingBoardItems && !isListingInvalidated) ||
    (selectedStripIndex >= 0 && stripPositionIsCurrent) ||
    (selectedLocalListingIndex !== undefined && !isListingInvalidated) ||
    (namedPositionIsCurrent && namedSelectionIndex >= 0 && !isListingInvalidated) ||
    (savedCursorMatchesListing && !shouldResolveSelection && !isListingInvalidated);
  const isNavigationReady =
    !hasNavigationContext ||
    followedSessionId !== null ||
    selectedItemKey === null ||
    (resolvedCursor !== null &&
      !isFetchingBoardItems &&
      !isListingInvalidated &&
      selectionPositionIsCurrent &&
      selectedPageIsLoaded === true &&
      !(hasStrip && !stripPositionIsCurrent));
  const resolvedPositionContextKey = `${navigationContextKey}:${resolvedCursor?.section ?? ''}:${resolvedCursor?.index ?? ''}`;

  if (
    !hasStaleNavigationAnchor &&
    hasNavigationContext &&
    boardItemsData !== undefined &&
    !selectedPageIsLoaded &&
    navigationAnchor.reanchorContextKey !== resolvedPositionContextKey
  ) {
    setNavigationAnchor({
      page: resolvedSelectionPage,
      queryKey: navigationQueryKey,
      reanchorContextKey: resolvedPositionContextKey,
      revision: navigationAnchor.revision + 1,
    });
  }
  const stripItems = useMemo(() => {
    if (queriedStripItems.length === 0) {
      return EMPTY_PREVIEW_ITEMS;
    }

    // Keep an off-window cursor in strip only when Gallery stamped that section.
    return resolvedCursor?.section === 'starred-strip' &&
      selectedItem &&
      !queriedStripItems.some((item) => toGalleryItemKey(item) === selectedItemKey)
      ? [...queriedStripItems, selectedItem]
      : queriedStripItems;
  }, [queriedStripItems, resolvedCursor, selectedItem, selectedItemKey]);
  const getSelectionCursorIn = useCallback(
    (item: GalleryItem, data: typeof boardItemsData): GallerySelectionCursor | null => {
      const itemKey = toGalleryItemKey(item);
      const listingIndex = getSelectionIndexIn(item, data);
      const localListingIndex = listingIndex === undefined ? getLocalListingIndexIn(item, data) : undefined;
      const starredStripIndex = stripItems.findIndex((candidate) => toGalleryItemKey(candidate) === itemKey);

      return resolveGallerySelectionCursor({
        itemKey,
        listingId: navigationListingId,
        listingIndex: listingIndex ?? localListingIndex,
        savedCursor:
          itemKey === selectedItemKey && savedCursorMatchesListing && savedCursor?.itemKey === itemKey
            ? savedCursor
            : null,
        starredStripIndex: starredStripIndex >= 0 ? starredStripIndex : undefined,
      });
    },
    [
      getLocalListingIndexIn,
      getSelectionIndexIn,
      navigationListingId,
      savedCursor,
      savedCursorMatchesListing,
      selectedItemKey,
      stripItems,
    ]
  );
  const getSelectionPageIn = useCallback(
    (item: GalleryItem, data: typeof boardItemsData): number => {
      const cursor = getSelectionCursorIn(item, data);
      // Ranked picks use board page zero, never ranking offsets. Listing picks use the absolute backend page, even
      // when a sliding window has evicted earlier pages.
      return navigationSemanticQuery !== null
        ? 0
        : cursor?.section === 'starred-strip'
          ? 0
          : cursor
            ? Math.floor(cursor.index / GALLERY_PAGE_SIZE)
            : 0;
    },
    [getSelectionCursorIn, navigationSemanticQuery]
  );
  const stampSelection = useCallback(
    (item: GalleryItem, data: typeof boardItemsData) =>
      selectGalleryItem(item, getSelectionPageIn(item, data), getSelectionCursorIn(item, data)),
    [getSelectionCursorIn, getSelectionPageIn, selectGalleryItem]
  );
  const getSelectionPage = useCallback(
    (item: GalleryItem) => getSelectionPageIn(item, boardItemsData),
    [boardItemsData, getSelectionPageIn]
  );
  const getSelectionCursor = useCallback(
    (item: GalleryItem) => getSelectionCursorIn(item, boardItemsData),
    [boardItemsData, getSelectionCursorIn]
  );
  const getSelectionPageAfterRemoval = useCallback(
    (item: GalleryItem, _orderedRefs: GalleryItemRef[], removedRefs: GalleryItemRef[]) => {
      const itemIndex = getSelectionIndexIn(item, boardItemsData);

      if (itemIndex === undefined) {
        return getSelectionPageIn(item, boardItemsData);
      }

      const removedBefore = removedRefs.reduce((count, ref) => {
        const removedItem = boardItemsData?.pages
          .flatMap((page) => page.items)
          .find((candidate) => toGalleryItemKey(candidate) === toGalleryItemKey(ref));
        const removedIndex = removedItem ? getSelectionIndexIn(removedItem, boardItemsData) : undefined;

        return count + (removedIndex !== undefined && removedIndex < itemIndex ? 1 : 0);
      }, 0);

      return Math.floor((itemIndex - removedBefore) / GALLERY_PAGE_SIZE);
    },
    [boardItemsData, getSelectionIndexIn, getSelectionPageIn]
  );
  const selectPreviewItem = useCallback(
    (item: GalleryItem) => stampSelection(item, boardItemsData),
    [boardItemsData, stampSelection]
  );

  const optimisticQueueItemIds = useMemo(
    () =>
      new Set(
        queueItems.filter((item) => item.status === 'pending' || item.status === 'running').map((item) => item.id)
      ),
    [queueItems]
  );
  const navigationLocalItems = useMemo(() => {
    // Keep recent results until listings catch up, except in filtered or mid-board windows where they do not
    // belong. Those windows merge only in-flight work and selection.
    const hasActiveSearch =
      navigationStarredOnly || selectedImageSearch.text.trim() !== '' || selectedImageSearch.range !== undefined;

    if (!hasActiveSearch && !isPaginatedWindow && hasTopPage) {
      return localItems;
    }

    const refreshingSelectedSourceId =
      isFetchingBoardItems && selectedItem?.kind === 'image' ? selectedItem.sourceQueueItemId : null;

    return localItems.filter(
      (item) =>
        (item.sourceQueueItemId !== undefined && optimisticQueueItemIds.has(item.sourceQueueItemId)) ||
        item.sourceQueueItemId === refreshingSelectedSourceId
    );
  }, [
    hasTopPage,
    isFetchingBoardItems,
    isPaginatedWindow,
    localItems,
    navigationStarredOnly,
    optimisticQueueItemIds,
    selectedImageSearch,
    selectedItem,
  ]);
  const localBoardItems = useMemo(
    () =>
      getOrderedLocalItems({
        boardId: navigationBoardId,
        galleryView: navigationGalleryView,
        items: navigationLocalItems,
        imageOrderDir: navigationOrderDir,
      }),
    [navigationBoardId, navigationGalleryView, navigationLocalItems, navigationOrderDir]
  );
  const previewLocalBoardItems = useMemo(() => {
    // A recent starred since it landed has moved to the strip.
    const listingLocalItems = hasStrip ? localBoardItems.filter((item) => !item.starred) : localBoardItems;

    if (
      !selectedItem ||
      (hasStrip && selectedItem.starred) ||
      listingLocalItems.some((item) => toGalleryItemKey(item) === selectedItemKey)
    ) {
      return listingLocalItems;
    }

    return [selectedItem, ...listingLocalItems];
  }, [hasStrip, localBoardItems, selectedItem, selectedItemKey]);
  const backendBoardItems = useMemo(() => flattenPreviewItems(boardItemsData), [boardItemsData]);
  // Rankings accept only selection as cursor anchor, never board recents.
  const previewMergeItems = useMemo(
    () =>
      navigationSemanticQuery === null ? previewLocalBoardItems : selectedItem ? [selectedItem] : EMPTY_PREVIEW_ITEMS,
    [navigationSemanticQuery, previewLocalBoardItems, selectedItem]
  );
  // The listing and the strip refetch independently, so an item just starred
  // can sit on both sides for a moment; the strip keeps it.
  const stripKeys = useMemo(() => new Set(stripItems.map(toGalleryItemKey)), [stripItems]);
  const mergeListingItems = useCallback(
    (backendItems: GalleryItem[]) =>
      mergePreviewBoardItems(backendItems, previewMergeItems, navigationOrderDir, {
        isRanked: navigationSemanticQuery !== null,
      }).filter((item) => !stripKeys.has(toGalleryItemKey(item))),
    [navigationOrderDir, navigationSemanticQuery, previewMergeItems, stripKeys]
  );
  const listingItems = useMemo(
    () => (hasNavigationContext ? mergeListingItems(backendBoardItems) : EMPTY_PREVIEW_ITEMS),
    [backendBoardItems, hasNavigationContext, mergeListingItems]
  );
  const boardItems = useMemo(
    () => (stripItems.length === 0 ? listingItems : [...stripItems, ...listingItems]),
    [listingItems, stripItems]
  );
  const isLoadingBoard =
    hasNavigationContext &&
    (isFetchingBoardItems ||
      isListingInvalidated ||
      (shouldResolveSelection && orderedNamesQuery.isFetching) ||
      (hasStrip && isFetchingStrip && resolvedCursor?.section === 'starred-strip'));
  const sessionEntries = useMemo(
    (): GalleryNavigationEntry[] =>
      progressSessions.map((session) => ({ id: session.id, kind: 'session', navigable: session.state === 'running' })),
    [progressSessions]
  );
  const stripEntries = useMemo(() => toItemEntries(stripItems), [stripItems]);
  const navigationSections = useMemo(
    () => [sessionEntries, stripEntries, toItemEntries(listingItems)],
    [listingItems, sessionEntries, stripEntries]
  );
  const cursorKey = followedSessionId !== null ? getGallerySessionNavigationKey(followedSessionId) : selectedItemKey;
  const navigationCursor =
    followedSessionId !== null || selectedItemKey === null
      ? -1
      : boardItems.findIndex((item) => toGalleryItemKey(item) === selectedItemKey);

  // Preview is the only surface that walks a paginated listing across its pages, so at a loaded edge the next page
  // wins over the strip seam; the strip is reached from the listing's first page.
  const isAtLoadedBackendBoundary = useCallback(
    (offset: -1 | 1): boolean =>
      followedSessionId === null &&
      selectedItemKey !== null &&
      (offset === 1
        ? backendBoardItems.at(-1) !== undefined &&
          toGalleryItemKey(backendBoardItems.at(-1)!) === selectedItemKey &&
          hasNextBoardItemsPage
        : backendBoardItems[0] !== undefined &&
          toGalleryItemKey(backendBoardItems[0]) === selectedItemKey &&
          hasPreviousBoardItemsPage),
    [backendBoardItems, followedSessionId, hasNextBoardItemsPage, hasPreviousBoardItemsPage, selectedItemKey]
  );

  // Share navigation between keyboard, footer, and swipe; comparison does not step saved images.
  const navigate = useCallback(
    (offset: -1 | 1): Promise<boolean> => {
      if (isComparing || !isNavigationReady) {
        return Promise.resolve(false);
      }

      const direction = offset === 1 ? 'right' : 'left';
      const stepTo = (entry: GalleryNavigationEntry | null, data: typeof boardItemsData): boolean => {
        if (entry?.kind === 'session') {
          followSession(entry.id);
        } else if (entry) {
          stampSelection(entry.item, data);
        }

        return entry !== null;
      };

      if (!isAtLoadedBackendBoundary(offset)) {
        return Promise.resolve(
          stepTo(getGalleryNavigationStep(navigationSections, cursorKey, direction), boardItemsData)
        );
      }

      if (offset === 1 ? isFetchingNextBoardItemsPage : isFetchingPreviousBoardItemsPage) {
        return Promise.resolve(false);
      }

      const fetchBoundaryPage = offset === 1 ? fetchNextBoardItemsPage : fetchPreviousBoardItemsPage;

      return fetchBoundaryPage().then((result) => {
        if (result.isError || result.data === undefined || navigationContextKeyRef.current !== navigationContextKey) {
          return false;
        }

        // Against the data just fetched: the item is not in the pages this
        // render closed over, and a lookup there would read it as an item
        // the window does not hold.
        const nextSections = [
          sessionEntries,
          stripEntries,
          toItemEntries(mergeListingItems(flattenPreviewItems(result.data))),
        ];

        return stepTo(getGalleryNavigationStep(nextSections, cursorKey, direction), result.data);
      });
    },
    [
      boardItemsData,
      cursorKey,
      fetchNextBoardItemsPage,
      fetchPreviousBoardItemsPage,
      followSession,
      isAtLoadedBackendBoundary,
      isComparing,
      isNavigationReady,
      isFetchingNextBoardItemsPage,
      isFetchingPreviousBoardItemsPage,
      mergeListingItems,
      navigationContextKey,
      navigationSections,
      sessionEntries,
      stampSelection,
      stripEntries,
    ]
  );

  const handleNavigationKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target instanceof Element && event.target.closest('video')) {
        return;
      }

      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return;
      }

      if (isComparing) {
        return;
      }

      // stopPropagation keeps the widget hotkey runtime from handling the same
      // arrow press a second time.
      event.preventDefault();
      event.stopPropagation();
      void navigate(event.key === 'ArrowLeft' ? -1 : 1);
    },
    [isComparing, navigate]
  );

  // The same resolution navigate() makes, so a swipe reveals what committing it will select.
  const neighbors = useMemo((): PreviewNeighbors => {
    if (isComparing || !isNavigationReady) {
      return NO_NEIGHBORS;
    }

    const resolve = (offset: -1 | 1): PreviewNeighbor =>
      isAtLoadedBackendBoundary(offset)
        ? { kind: 'more' }
        : toNeighbor(getGalleryNavigationStep(navigationSections, cursorKey, offset === 1 ? 'right' : 'left'));

    return { next: resolve(1), previous: resolve(-1) };
  }, [cursorKey, isAtLoadedBackendBoundary, isComparing, isNavigationReady, navigationSections]);

  // Prefetch the images a step would land on to avoid decode flashes during navigation.
  const previousNeighborUrl =
    neighbors.previous?.kind === 'item' && neighbors.previous.item.kind === 'image'
      ? neighbors.previous.item.fullUrl
      : null;
  const nextNeighborUrl =
    neighbors.next?.kind === 'item' && neighbors.next.item.kind === 'image' ? neighbors.next.item.fullUrl : null;

  useEffect(() => {
    [previousNeighborUrl, nextNeighborUrl].forEach((url) => {
      if (url) {
        new Image().src = url;
      }
    });
  }, [nextNeighborUrl, previousNeighborUrl]);

  return {
    boardItems,
    handleNavigationKeyDown,
    isLoadingBoard,
    navigate,
    neighbors,
    navigationCursor,
    navigationQueryKey,
    getSelectionPage,
    getSelectionCursor,
    getSelectionPageAfterRemoval,
    selectPreviewItem,
  };
};
