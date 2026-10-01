import { Box, chakra, Flex, HStack, Icon, ScrollArea, Spinner, Stack, Text } from '@chakra-ui/react';
import { getGalleryBoardLabel } from '@features/gallery/core/boardLabels';
import { toGalleryItemKey, type GalleryItem, type GalleryItemKey } from '@features/gallery/core/items';
import {
  getGalleryRevealRequest,
  getGallerySessionNavigationKey,
  subscribeGalleryRevealRequests,
  type GalleryNavigationEntry,
  type GalleryRevealRequest,
} from '@features/gallery/core/selection';
import { isDateBoardId } from '@features/gallery/data/backend';
import { GALLERY_PAGE_SIZE, imageIndexAvailabilityOptions } from '@features/gallery/data/queries';
import { captureAccountScope } from '@platform/state/accountLifecycle';
import { Button, DropZone } from '@platform/ui';
import { useQuery } from '@tanstack/react-query';
import { ChevronRightIcon, StarIcon, UploadIcon } from 'lucide-react';
import {
  useCallback,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useVirtualizer } from 'react-hook-tanstack-virtual';
import { useTranslation } from 'react-i18next';

import {
  buildGalleryGridWindowRows,
  chunkGalleryCellsIntoRows,
  GALLERY_GRID_GAP_PX,
  GALLERY_PINNED_FOOTER_PX,
  GALLERY_STARRED_HEADER_HEIGHT_PX,
  getGalleryCellSizePx,
  getGalleryColumnCount,
  getGalleryGridRowIndexForItemKey,
  getGalleryGridWindowIndexForItemKey,
  getGalleryGridWindowRowIndexForItemKey,
  getGalleryPinnedHeightPx,
  getGalleryProgressLayout,
  getGalleryStarredLayout,
  getGalleryStarredStripItems,
  type GalleryGridWindowRow,
} from './galleryGridLayout';
import { GalleryProgressSection } from './GalleryProgressSection';
import { GalleryThumbnailCell } from './GalleryThumbnail';
import { useGalleryUi } from './GalleryUiContext';
import { useGalleryWidget } from './GalleryWidgetContext';
import { useGalleryGridHotkeys } from './useGalleryGridHotkeys';
import { useGalleryGridSelection } from './useGalleryGridSelection';
import { useGalleryUploadInput } from './useGalleryUploadInput';

/**
 * Seeds the measured width per region so remounting the gallery in a placement
 * it has already been shown in does not paint one frame of fallback-sized
 * tiles before the ResizeObserver reports.
 */
const viewportWidthCache = new Map<string, number>();
const STARRED_TRIGGER_HOVER_STYLES = { color: 'fg' } as const;

// Module-scoped so a grid remount cannot replay an already-followed reveal.
let lastPageFollowedRevealToken = 0;

const dragEventContainsFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer.types).includes('Files');

/** Show all appears only when starred items exceed the strip and activates the starred-only listing. */
const GalleryStarredSectionHeader = ({
  isOpen,
  onShowAll,
  onToggle,
  shownCount,
  total,
}: {
  isOpen: boolean;
  onShowAll: () => void;
  onToggle: () => void;
  shownCount: number;
  total: number;
}) => {
  const { t } = useTranslation();

  return (
    <Flex align="center" gap="1" h={`${GALLERY_STARRED_HEADER_HEIGHT_PX}px`} px="1" w="full">
      <chakra.button
        aria-expanded={isOpen}
        aria-label={t(isOpen ? 'widgets.gallery.collapseStarredItems' : 'widgets.gallery.expandStarredItems')}
        alignItems="center"
        color="fg.muted"
        display="flex"
        flex="1"
        gap="1"
        minW="0"
        transition="color var(--wb-motion-duration-fast) ease"
        type="button"
        _hover={STARRED_TRIGGER_HOVER_STYLES}
        onClick={onToggle}
      >
        <Icon
          as={ChevronRightIcon}
          boxSize="3"
          transform={isOpen ? 'rotate(90deg)' : undefined}
          transition="transform var(--wb-motion-duration-medium) ease"
        />
        <Icon as={StarIcon} boxSize="3" fill="currentColor" />
        <HStack gap="1" minW="0">
          <Text
            as="span"
            fontSize="2xs"
            fontWeight="600"
            letterSpacing="wide"
            lineHeight="1"
            textTransform="uppercase"
            truncate
          >
            {t('widgets.gallery.starredItems')}
          </Text>
          <Text as="span" color="currentColor" fontSize="2xs" fontVariantNumeric="tabular-nums" lineHeight="1">
            {total}
          </Text>
        </HStack>
      </chakra.button>
      {total > shownCount ? (
        <Button
          aria-label={t('widgets.gallery.showAllStarredItems')}
          color="fg.muted"
          flexShrink={0}
          size="2xs"
          variant="ghost"
          onClick={onShowAll}
        >
          {t('widgets.gallery.showAllStarred')}
        </Button>
      ) : null}
    </Flex>
  );
};

/**
 * Render the bounded starred strip outside virtualization while preserving its place in cross-section keyboard
 * navigation.
 */
const GalleryStarredSection = ({
  cells,
  cellSizePx,
  columnCount,
  isOpen,
  renderCell,
  total,
  onShowAll,
  onToggle,
}: {
  cells: GalleryItem[];
  /** Rows take the listing's pitch explicitly, so the pinned block measures what the layout computed. */
  cellSizePx: number;
  columnCount: number;
  isOpen: boolean;
  renderCell: (item: GalleryItem) => ReactNode;
  total: number;
  onShowAll: () => void;
  onToggle: () => void;
}) => {
  const { t } = useTranslation();
  const rows = useMemo(() => chunkGalleryCellsIntoRows(cells, columnCount, 'starred'), [cells, columnCount]);

  return (
    <Box>
      <GalleryStarredSectionHeader
        isOpen={isOpen}
        shownCount={isOpen ? cells.length : 0}
        total={total}
        onShowAll={onShowAll}
        onToggle={onToggle}
      />
      {isOpen ? (
        <Box aria-label={t('widgets.gallery.starredItems')} role="list">
          {rows.map((row) => (
            <Box
              key={row.key}
              data-gallery-section="starred"
              display="grid"
              gap={`${GALLERY_GRID_GAP_PX}px`}
              gridTemplateColumns={`repeat(${columnCount}, minmax(0, 1fr))`}
              h={`${cellSizePx}px`}
              mb={`${GALLERY_GRID_GAP_PX}px`}
              role="presentation"
              w="full"
            >
              {row.cells.map(renderCell)}
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
};

const GalleryVirtualRow = ({
  cellSizePx,
  columnCount,
  onItemMounted,
  renderCell,
  row,
  startPx,
}: {
  cellSizePx: number;
  columnCount: number;
  onItemMounted: (item: GalleryItem, index: number) => void;
  renderCell: (item: GalleryItem) => ReactNode;
  row: GalleryGridWindowRow;
  startPx: number;
}) => {
  const setRowRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) {
        row.cells.forEach((item, columnIndex) => {
          if (item) {
            onItemMounted(item, row.index * columnCount + columnIndex);
          }
        });
      }
    },
    [columnCount, onItemMounted, row]
  );

  return (
    <Box
      ref={setRowRef}
      data-gallery-section={row.section}
      display="grid"
      gap={`${GALLERY_GRID_GAP_PX}px`}
      gridTemplateColumns={`repeat(${columnCount}, minmax(0, 1fr))`}
      h={`${cellSizePx}px`}
      left="0"
      position="absolute"
      role="presentation"
      top="0"
      transform={`translateY(${startPx}px)`}
      w="full"
    >
      {row.cells.map((item, columnIndex) =>
        item ? (
          renderCell(item)
        ) : (
          <Box
            key={`placeholder:${row.index}:${columnIndex}`}
            aria-hidden="true"
            aspectRatio="1"
            gridColumn={columnIndex + 1}
            role="presentation"
          />
        )
      )}
    </Box>
  );
};

/** Measure viewport width for columns so both layouts share the same grid. */
export const GalleryImageGrid = () => {
  const { t } = useTranslation();
  const { actions, filter, gallery, itemActions, listing, region, starredStrip } = useGalleryWidget();
  const {
    gallery: galleryCommands,
    getItemLabel,
    ImageContextMenu,
    followedProgressSessionId,
    progressSessions,
  } = useGalleryUi();
  const { data: indexAvailability } = useQuery(imageIndexAvailabilityOptions());
  const accountScope = captureAccountScope();
  const revealRequest = useSyncExternalStore(subscribeGalleryRevealRequests, getGalleryRevealRequest);
  const getReadyItemLabel = indexAvailability?.state === 'ready' ? getItemLabel : null;
  const [isDropActive, setIsDropActive] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => viewportWidthCache.get(region) ?? 0);
  const dragDepthRef = useRef(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const viewportAnchorRef = useRef<{
    accountEpoch: number;
    filterIdentity: string;
    itemKey: string;
    scrollTop: number;
    top: number;
  } | null>(null);
  const {
    imageDensityPercent,
    paginationMode,
    progressSectionCollapsed,
    showImageDimensions,
    showPendingItems,
    starredSectionCollapsed,
    thumbnailFit,
  } = gallery.settings;
  const isStarredOpen = !starredSectionCollapsed;

  const {
    actionSelectionRefs,
    activeContextMenuTarget,
    getDragItems,
    handleCloseContextMenu,
    handleThumbnailClick,
    handleThumbnailContextMenu,
    loadedItems,
    selectedItemKeys,
    syncRangeInteractionContext,
  } = useGalleryGridSelection();

  const columnCount = getGalleryColumnCount({ imageDensityPercent, widthPx: viewportWidth });
  const isFollowingLive = followedProgressSessionId !== null;
  const isComparisonActive = gallery.isComparisonActive && !isFollowingLive;
  const selectedBoard = gallery.boards.find((board) => board.id === gallery.selectedBoardId);
  const selectedBoardName = selectedBoard
    ? getGalleryBoardLabel(selectedBoard, t)
    : t('widgets.gallery.selectedBoardFallback');
  // The listing is unstarred-only, so a board whose items are all starred
  // still has the strip to show.
  const isEmpty = (listing ? listing.total === 0 : gallery.items.length === 0) && starredStrip.items.length === 0;
  // A ranking that matched nothing is still a search result, never an empty
  // board inviting an upload.
  const hasActiveSearch = gallery.searchTerm.trim() !== '' || gallery.semanticImageQuery !== null;
  const isVirtualBoard = isDateBoardId(gallery.selectedBoardId);

  const itemsByIndex = useMemo(() => {
    if (listing) {
      return listing.itemsByIndex;
    }

    return new Map(gallery.items.map((item, index) => [index, item]));
  }, [gallery.items, listing]);
  const starredCells = useMemo(
    () => getGalleryStarredStripItems(starredStrip.items, columnCount),
    [columnCount, starredStrip.items]
  );
  // Exclude collapsed tiles from navigation, but retain hidden starred selections' section identity so arrows can
  // step out.
  const isProgressOpen = showPendingItems && !progressSectionCollapsed;
  const navigationSections = useMemo((): GalleryNavigationEntry[][] => {
    const shownStripItems = isStarredOpen ? starredCells : [];
    const selectedKey = gallery.selectedItemKey;
    const isSelected = (item: GalleryItem) => toGalleryItemKey(item) === selectedKey;
    const hiddenStripSelection =
      selectedKey !== null && !shownStripItems.some(isSelected) && !gallery.items.some(isSelected)
        ? starredStrip.items.find(isSelected)
        : undefined;
    const stripEntries: GalleryNavigationEntry[] = shownStripItems.map((item) => ({ item, kind: 'item' }));

    if (hiddenStripSelection) {
      stripEntries.push({ item: hiddenStripSelection, kind: 'item' });
    }

    return [
      stripEntries,
      isProgressOpen
        ? progressSessions.map((session) => ({
            id: session.id,
            kind: 'session',
            navigable: session.state === 'running',
          }))
        : [],
      gallery.items.map((item) => ({ item, kind: 'item' })),
    ];
  }, [
    gallery.items,
    gallery.selectedItemKey,
    isProgressOpen,
    isStarredOpen,
    progressSessions,
    starredCells,
    starredStrip.items,
  ]);
  const cursorKey =
    followedProgressSessionId !== null
      ? getGallerySessionNavigationKey(followedProgressSessionId)
      : (gallery.selectedItemKey ?? gallery.primarySelectedItemKey);

  const itemCount = useMemo(() => {
    if (listing?.total !== null && listing?.total !== undefined) {
      return listing.total;
    }

    let maxIndex = 0;

    for (const index of itemsByIndex.keys()) {
      maxIndex = Math.max(maxIndex, index + 1);
    }

    return maxIndex;
  }, [itemsByIndex, listing?.total]);
  const rowCount = Math.ceil(itemCount / columnCount);
  const cellSizePx = getGalleryCellSizePx({ columnCount, widthPx: viewportWidth });
  const rowHeightPx = cellSizePx + GALLERY_GRID_GAP_PX;
  const estimateRowSize = useCallback(() => rowHeightPx, [rowHeightPx]);
  const getRowKey = useCallback((index: number) => `regular:${index}`, []);
  const getScrollElement = useCallback(() => viewportRef.current, []);
  const listingIndices = listing?.itemsByIndex;
  const lastAlignedAnchorRef = useRef<string | null>(null);
  const filterIdentity = JSON.stringify(filter);

  const progressLayout = getGalleryProgressLayout({
    columns: columnCount,
    tileSize: cellSizePx,
    sessionCount: progressSessions.length,
    visible: showPendingItems,
    collapsed: progressSectionCollapsed,
  });
  const starredLayout = getGalleryStarredLayout({
    collapsed: !isStarredOpen,
    columns: columnCount,
    shownCount: starredCells.length,
    tileSize: cellSizePx,
  });
  const pinnedHeight = getGalleryPinnedHeightPx(progressLayout.height, starredLayout.height);
  const captureViewportAnchor = useEffectEvent(() => {
    if (paginationMode !== 'infinite' || listingIndices === undefined) {
      viewportAnchorRef.current = null;
      return;
    }

    const viewport = viewportRef.current;
    const viewportRect = viewport?.getBoundingClientRect();
    const visibleAnchor =
      viewport && viewportRect
        ? [...viewport.querySelectorAll<HTMLElement>('[data-gallery-item-key]')]
            .map((element) => ({ element, rect: element.getBoundingClientRect() }))
            .filter(({ rect }) => rect.bottom > viewportRect.top && rect.top < viewportRect.bottom)
            .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
            .find(({ element }) => {
              const itemKey = element.dataset.galleryItemKey;
              return itemKey !== undefined && getGalleryGridWindowIndexForItemKey(listingIndices, itemKey) >= 0;
            })
        : undefined;
    const itemKey = visibleAnchor?.element.dataset.galleryItemKey;
    const index = itemKey === undefined ? -1 : getGalleryGridWindowIndexForItemKey(listingIndices, itemKey);

    viewportAnchorRef.current =
      itemKey === undefined || index < 0 || visibleAnchor === undefined || viewport === null
        ? null
        : {
            accountEpoch: accountScope.epoch,
            filterIdentity,
            itemKey,
            scrollTop: viewport.scrollTop,
            top: visibleAnchor.rect.top - (viewportRect?.top ?? 0),
          };
  });
  const virtualizer = useVirtualizer({
    count: rowCount,
    scrollMargin: pinnedHeight,
    estimateSize: estimateRowSize,
    getItemKey: getRowKey,
    getScrollElement,
    overscan: 4,
    onChange: (instance) => {
      if (!listing || paginationMode !== 'infinite' || itemCount === 0) {
        return;
      }

      // Explicit deep reveals begin at the anchor page. The first fetched
      // page makes the full absolute spacer possible; move to that page before
      // asking the range loader for the viewport at zero.
      if (
        gallery.anchoredWindowPage > 0 &&
        listing.offset > 0 &&
        listing.itemsByIndex.size > 0 &&
        (viewportRef.current?.scrollTop ?? 0) === 0
      ) {
        const anchorIdentity = `${accountScope.epoch}:${filterIdentity}:${gallery.anchoredWindowPage}:${revealRequest?.token ?? 'initial'}`;

        if (lastAlignedAnchorRef.current !== anchorIdentity) {
          lastAlignedAnchorRef.current = anchorIdentity;
          instance.scrollToIndex(Math.floor((listing.virtualOffset ?? listing.offset) / columnCount));
          return;
        }
      }

      const indexes = instance.getVirtualIndexes();
      const firstRow = indexes[0];
      const lastRow = indexes[indexes.length - 1];

      if (firstRow === undefined || lastRow === undefined) {
        return;
      }

      listing.loadRange(firstRow * columnCount, Math.min(itemCount - 1, (lastRow + 1) * columnCount - 1));
    },
  });

  const measureVirtualizer = useEffectEvent(() => {
    virtualizer.measure();
  });
  // The hotkey callback reads current state when invoked; stabilizing its identity adds no value and interferes
  // with compiler memoization.
  /** Returns whether the item had somewhere to scroll to — a collapsed strip has none. */
  const scrollToItemKey = useCallback(
    (itemKey: GalleryItemKey): boolean => {
      const rowIndex = listing
        ? getGalleryGridWindowRowIndexForItemKey(itemsByIndex, itemKey, columnCount)
        : getGalleryGridRowIndexForItemKey(gallery.items, itemKey, columnCount);

      if (rowIndex >= 0) {
        virtualizer.scrollToIndex(rowIndex);
        return true;
      }

      // Strip cells sit in the pinned block at the top of the scroll content.
      if (isStarredOpen && starredCells.some((item) => toGalleryItemKey(item) === itemKey)) {
        viewportRef.current?.scrollTo({ top: 0 });
        return true;
      }

      return false;
    },
    [columnCount, gallery.items, isStarredOpen, itemsByIndex, listing, starredCells, virtualizer]
  );
  const scrollToAbsoluteIndex = useCallback(
    (index: number) => virtualizer.scrollToIndex(Math.floor(index / columnCount)),
    [columnCount, virtualizer]
  );
  const scrollToEntry = useCallback(
    (entry: GalleryNavigationEntry) => {
      if (entry.kind === 'session') {
        // In-progress tiles sit below the starred strip; scroll only when the target tile's row is out of view.
        const viewport = viewportRef.current;
        const sessionIndex = progressSessions.findIndex((session) => session.id === entry.id);

        if (viewport && sessionIndex >= 0) {
          const rowTop =
            starredLayout.height +
            progressLayout.headerHeight +
            Math.floor(sessionIndex / progressLayout.columns) * progressLayout.rowHeight;
          const rowBottom = rowTop + progressLayout.rowHeight;

          if (rowTop < viewport.scrollTop) {
            viewport.scrollTo({ top: rowTop - progressLayout.headerHeight });
          } else if (rowBottom > viewport.scrollTop + viewport.clientHeight) {
            viewport.scrollTo({ top: rowBottom - viewport.clientHeight });
          }
        }
      } else {
        scrollToItemKey(toGalleryItemKey(entry.item));
      }
    },
    [progressLayout, progressSessions, scrollToItemKey, starredLayout.height]
  );

  const onListingItemMounted = useGalleryGridHotkeys({
    actionSelectionRefs,
    columnCount,
    cursorKey,
    loadedItems,
    navigationSections,
    scrollToAbsoluteIndex,
    scrollToEntry,
  });

  // Only explicit reveals scroll. Retry while the item loads; retire the request when another selection supersedes
  // it.
  const pendingRevealRef = useRef<GalleryRevealRequest | null>(null);
  // Honor requests preceding mount; selection mismatch, rather than request age, determines staleness.
  const consumedRevealTokenRef = useRef(0);
  const handleGridRowsCommitted = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) {
        return;
      }

      if (revealRequest && revealRequest.token !== consumedRevealTokenRef.current) {
        consumedRevealTokenRef.current = revealRequest.token;
        pendingRevealRef.current = revealRequest;
      }

      const pending = pendingRevealRef.current;

      if (!pending) {
        return;
      }

      // Another selection retires the reveal; the persisted set catches off-page selections whose visible key is null.
      if (
        (gallery.selectedItemKey !== null && gallery.selectedItemKey !== pending.itemKey) ||
        (gallery.selectedItemKeys.length > 0 && !gallery.selectedItemKeys.includes(pending.itemKey))
      ) {
        pendingRevealRef.current = null;
        return;
      }

      // The row is committed after the indexed window changes, so a reveal
      // retries when the requested item arrives without a render effect.
      if (scrollToItemKey(pending.itemKey)) {
        pendingRevealRef.current = null;
        return;
      }

      // Follow an off-window target once; a target that never materializes cannot keep pulling the user back.
      if (
        !loadedItems.some((item) => toGalleryItemKey(item) === pending.itemKey) &&
        gallery.revealTargetPage !== null &&
        gallery.revealTargetPage !== gallery.page &&
        lastPageFollowedRevealToken !== pending.token
      ) {
        lastPageFollowedRevealToken = pending.token;
        if (listing && paginationMode === 'infinite') {
          const backendFirst = gallery.revealTargetPage * GALLERY_PAGE_SIZE;
          const first =
            listing.getDisplayIndexForBackendIndex?.(backendFirst) ?? backendFirst + (listing.leadingOverlayCount ?? 0);
          listing.loadRange(first, first + GALLERY_PAGE_SIZE - 1);
        } else {
          galleryCommands.setPage(gallery.revealTargetPage);
        }
      }
    },
    [
      gallery.page,
      gallery.revealTargetPage,
      gallery.selectedItemKey,
      gallery.selectedItemKeys,
      galleryCommands,
      listing,
      loadedItems,
      paginationMode,
      revealRequest,
      scrollToItemKey,
    ]
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return;
    }

    const setMeasuredWidth = (width: number) => {
      if (width <= 0) {
        return;
      }

      viewportWidthCache.set(region, width);
      setViewportWidth((currentWidth) => (currentWidth === width ? currentWidth : width));
    };

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;

      if (typeof width === 'number') {
        setMeasuredWidth(width);
      }
    });

    setMeasuredWidth(viewport.clientWidth);
    observer.observe(viewport);

    return () => observer.disconnect();
  }, [isEmpty, region]);

  const virtualRows = virtualizer.virtualItems;
  const firstVirtualRow = virtualRows[0]?.index ?? 0;
  const lastVirtualRow = virtualRows[virtualRows.length - 1]?.index ?? firstVirtualRow;
  const rows = useMemo(
    () => buildGalleryGridWindowRows(itemsByIndex, columnCount, firstVirtualRow, lastVirtualRow),
    [columnCount, firstVirtualRow, itemsByIndex, lastVirtualRow]
  );
  const rowsByIndex = useMemo(() => new Map(rows.map((row) => [row.index, row])), [rows]);

  // Refresh row measurements before anchoring against the committed item positions.
  useLayoutEffect(() => {
    measureVirtualizer();
  }, [rowCount, rowHeightPx, pinnedHeight]);

  // Keep the last committed visible tile at the same viewport position when new completions shift display indices.
  useLayoutEffect(() => {
    if (paginationMode !== 'infinite' || listingIndices === undefined) {
      viewportAnchorRef.current = null;
      return;
    }

    const viewport = viewportRef.current;
    const previousAnchor = viewportAnchorRef.current;

    if (
      viewport &&
      previousAnchor &&
      previousAnchor.accountEpoch === accountScope.epoch &&
      previousAnchor.filterIdentity === filterIdentity &&
      previousAnchor.scrollTop > pinnedHeight &&
      viewport.scrollTop > pinnedHeight
    ) {
      const nextIndex = getGalleryGridWindowIndexForItemKey(listingIndices, previousAnchor.itemKey);

      if (nextIndex >= 0) {
        const nextRowStart = pinnedHeight + Math.floor(nextIndex / columnCount) * rowHeightPx;
        const correction = nextRowStart - (previousAnchor.scrollTop + previousAnchor.top);

        if (Math.abs(correction) > 0.5) {
          viewport.scrollTop += correction;
        }
      }
    }

    captureViewportAnchor();
  }, [accountScope.epoch, columnCount, filterIdentity, listingIndices, paginationMode, pinnedHeight, rowHeightPx]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return;
    }

    const handleScroll = () => captureViewportAnchor();
    viewport.addEventListener('scroll', handleScroll, { passive: true });

    return () => viewport.removeEventListener('scroll', handleScroll);
  }, []);

  const handleDragEnter = useCallback((event: DragEvent) => {
    if (!dragEventContainsFiles(event)) {
      return;
    }

    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDropActive(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent) => {
    if (!dragEventContainsFiles(event)) {
      return;
    }

    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);

    if (dragDepthRef.current === 0) {
      setIsDropActive(false);
    }
  }, []);

  const handleDragOver = useCallback((event: DragEvent) => {
    if (dragEventContainsFiles(event)) {
      event.preventDefault();
    }
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDropActive(false);

      const files = Array.from(event.dataTransfer.files);

      if (files.length > 0) {
        void actions.uploadFiles(files);
      }
    },
    [actions]
  );

  const { inputProps: uploadInputProps, openPicker: openUploadPicker } = useGalleryUploadInput(actions.uploadFiles);

  const handleUploadKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openUploadPicker();
      }
    },
    [openUploadPicker]
  );

  const handleToggleStarredSection = useCallback(
    () => actions.updateSettings({ starredSectionCollapsed: isStarredOpen }),
    [actions, isStarredOpen]
  );

  // Show all removes the header it lives in; focus moves first, to the
  // toolbar control that reports (and undoes) the filter, so keyboard users
  // are not dropped on the document body.
  const handleShowAllStarred = useCallback(() => {
    viewportRef.current
      ?.closest('[role="tabpanel"]')
      ?.parentElement?.querySelector<HTMLElement>('[data-gallery-starred-filter-toggle]')
      ?.focus();
    actions.setStarredOnly(true);
  }, [actions]);

  const handleToggleStarred = useCallback(
    (item: GalleryItem) => void itemActions.setItemsStarred([{ kind: item.kind, name: item.name }], !item.starred),
    [itemActions]
  );

  // Releasing the anchor puts the window back over the top of the listing.
  const handleReturnToBoardTop = useCallback(() => galleryCommands.setPage(0), [galleryCommands]);

  const renderCell = useCallback(
    (item: GalleryItem) => {
      const itemKey = toGalleryItemKey(item);

      return (
        <GalleryThumbnailCell
          key={itemKey}
          alwaysShowDimensions={showImageDimensions}
          dragScope={region}
          compareRole={
            isComparisonActive && itemKey === gallery.selectedItemKey
              ? t('widgets.preview.viewing')
              : isComparisonActive && itemKey === gallery.compareImageKey
                ? t('widgets.preview.compare')
                : null
          }
          fit={thumbnailFit}
          getDragItems={getDragItems}
          getItemLabel={getReadyItemLabel}
          isPrimary={!isFollowingLive && itemKey === gallery.selectedItemKey}
          isSelected={!isFollowingLive && selectedItemKeys.has(itemKey)}
          item={item}
          onClick={handleThumbnailClick}
          onContextMenu={handleThumbnailContextMenu}
          onToggleStarred={handleToggleStarred}
        />
      );
    },
    [
      gallery.compareImageKey,
      gallery.selectedItemKey,
      getDragItems,
      getReadyItemLabel,
      handleThumbnailClick,
      handleThumbnailContextMenu,
      handleToggleStarred,
      isComparisonActive,
      isFollowingLive,
      region,
      selectedItemKeys,
      showImageDimensions,
      t,
      thumbnailFit,
    ]
  );

  const anchoredWindowFirstItem = (listing?.virtualOffset ?? listing?.offset ?? 0) + 1;

  return (
    <Stack flex="1" gap="0" h="full" minH="0" minW="0" w="full">
      <Box
        ref={syncRangeInteractionContext}
        flex="1"
        h="full"
        maxW="full"
        minH="0"
        minW="0"
        position="relative"
        w="full"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {gallery.anchoredWindowPage > 0 ? (
          <Flex align="center" bg="bg.panel" gap="2" justify="space-between" px="2" py="1">
            <Text color="fg.muted" fontSize="2xs" truncate>
              {t('widgets.gallery.windowAnchored', { index: anchoredWindowFirstItem })}
            </Text>
            <Button flexShrink={0} size="2xs" variant="ghost" onClick={handleReturnToBoardTop}>
              {t('widgets.gallery.backToBoardTop')}
            </Button>
          </Flex>
        ) : null}
        <ScrollArea.Root h="full" minH="0" size="xs" variant="hover" w="full">
          <ScrollArea.Viewport ref={viewportRef} data-dnd-auto-scroll="false" h="full" outline="none" w="full">
            <ScrollArea.Content display="flex" flexDirection="column" minH="full">
              {pinnedHeight > 0 ? (
                <Box
                  borderBottomWidth="1px"
                  borderColor="border.subtle"
                  data-gallery-pinned
                  flexShrink={0}
                  mb={`${GALLERY_PINNED_FOOTER_PX - 1}px`}
                  minW="0"
                >
                  {starredCells.length > 0 ? (
                    <GalleryStarredSection
                      cells={starredCells}
                      cellSizePx={cellSizePx}
                      columnCount={columnCount}
                      isOpen={isStarredOpen}
                      renderCell={renderCell}
                      total={starredStrip.total}
                      onShowAll={handleShowAllStarred}
                      onToggle={handleToggleStarredSection}
                    />
                  ) : null}
                  <GalleryProgressSection
                    getScrollElement={getScrollElement}
                    layout={progressLayout}
                    offsetTopPx={starredLayout.height}
                  />
                </Box>
              ) : null}
              {isEmpty ? (
                gallery.isLoading || hasActiveSearch || isVirtualBoard || gallery.starredOnly ? (
                  <Flex align="center" color="fg.muted" flex="1" justify="center" minH="8rem">
                    <Text fontSize="xs">
                      {gallery.isLoading
                        ? t('widgets.gallery.loadingBackendGallery')
                        : gallery.starredOnly && gallery.semanticImageQuery === null
                          ? t('widgets.gallery.noStarredItemsMatch')
                          : t('widgets.gallery.noImagesMatch')}
                    </Text>
                  </Flex>
                ) : (
                  // No inset: the zone shares the thumbnails' outer edges.
                  <Flex align="stretch" flex="1" minH="8rem">
                    <input {...uploadInputProps} />
                    <DropZone
                      alignItems="center"
                      display="flex"
                      flex="1"
                      fontSize="xs"
                      isOver={isDropActive}
                      justifyContent="center"
                      role="button"
                      tabIndex={0}
                      onClick={openUploadPicker}
                      onKeyDown={handleUploadKeyDown}
                    >
                      <Stack align="center" gap="1">
                        <Icon as={UploadIcon} boxSize="4" color="fg.subtle" />
                        <Text color="fg.muted">{t('widgets.gallery.emptyBoardUploadHint')}</Text>
                      </Stack>
                    </DropZone>
                  </Flex>
                )
              ) : rowCount > 0 ? (
                <Box flexShrink={0} h={`${virtualizer.totalSize}px`} position="relative" w="full">
                  <Box
                    ref={handleGridRowsCommitted}
                    aria-label={t('widgets.gallery.itemsAriaLabel')}
                    h="full"
                    inset="0"
                    position="absolute"
                    role="list"
                    w="full"
                  >
                    {virtualRows.map((virtualRow) => {
                      const row = rowsByIndex.get(virtualRow.index);

                      if (!row) {
                        return null;
                      }

                      return (
                        <GalleryVirtualRow
                          key={virtualRow.key}
                          cellSizePx={cellSizePx}
                          columnCount={columnCount}
                          onItemMounted={onListingItemMounted}
                          renderCell={renderCell}
                          row={row}
                          startPx={virtualRow.start - pinnedHeight}
                        />
                      );
                    })}
                  </Box>
                </Box>
              ) : (
                <Flex align="center" color="fg.muted" flex="1" justify="center" minH="8rem">
                  {gallery.isLoading ? (
                    <Spinner color="fg.subtle" size="xs" />
                  ) : (
                    <Text fontSize="xs">{t('widgets.gallery.noImagesMatch')}</Text>
                  )}
                </Flex>
              )}
            </ScrollArea.Content>
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar>
            <ScrollArea.Thumb />
          </ScrollArea.Scrollbar>
        </ScrollArea.Root>
        {listing && (listing.error || (gallery.isLoading && itemCount > 0)) ? (
          <Flex
            align="center"
            aria-label={listing.error ? undefined : t('widgets.gallery.loadingBackendGallery')}
            bg="bg.panel"
            gap="2"
            insetX="0"
            justify="center"
            position="absolute"
            py="1"
            role={listing.error ? 'alert' : 'status'}
            top={gallery.anchoredWindowPage > 0 ? '2rem' : '0'}
            zIndex="2"
          >
            {listing.error ? (
              <>
                <Text color="fg.error" fontSize="xs" textAlign="center">
                  {listing.error.message}
                </Text>
                <Button disabled={gallery.isLoading} flexShrink={0} size="2xs" variant="ghost" onClick={listing.retry}>
                  {t('common.retry')}
                </Button>
              </>
            ) : (
              <Spinner color="fg.subtle" size="xs" />
            )}
          </Flex>
        ) : null}
        {isDropActive && (
          <DropZone
            alignItems="center"
            display="flex"
            flexDirection="column"
            gap="2"
            inset="0"
            isOver
            justifyContent="center"
            pointerEvents="none"
            position="absolute"
            variant="overlay"
            zIndex="1"
          >
            <UploadIcon size="20" />
            <Text fontSize="xs" fontWeight="600">
              {t('widgets.gallery.dropMediaToUploadToBoard', { name: selectedBoardName })}
            </Text>
          </DropZone>
        )}
        <ImageContextMenu boards={gallery.boards} target={activeContextMenuTarget} onClose={handleCloseContextMenu} />
      </Box>
    </Stack>
  );
};
