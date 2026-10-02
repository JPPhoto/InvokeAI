import type { SystemStyleObject } from '@chakra-ui/react';
import type { GalleryItem, GalleryItemKey } from '@features/gallery/core/items';
import type { CSSProperties, MouseEvent } from 'react';

import { Box, Icon, Skeleton, Stack, Text } from '@chakra-ui/react';
import { toGalleryItemKey } from '@features/gallery/core/items';
import { getGalleryColumnCountForCell } from '@features/gallery/ui/galleryGridLayout';
import { GalleryTileFrame } from '@features/gallery/ui/GalleryTileFrame';
import { Button } from '@platform/ui/Button';
import { Scrollable } from '@platform/ui/Scrollable';
import { CheckIcon } from 'lucide-react';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer, type Range } from 'react-hook-tanstack-virtual';
import { useTranslation } from 'react-i18next';

import {
  GALLERY_PICKER_CELL_PX,
  GALLERY_PICKER_MAX_COLUMNS,
  GALLERY_PICKER_MIN_COLUMNS,
  type GalleryPickerTileState,
} from './galleryPicker';

const GRID_GAP_PX = 4;
const SKELETON_TILE_COUNT = 8;
const VIRTUAL_OVERSCAN_ROWS = 3;
const UNKNOWN_TOTAL_TAIL = 60;

const IMG_STYLE: CSSProperties = {
  display: 'block',
  height: '100%',
  inset: 0,
  maxWidth: 'none',
  objectFit: 'cover',
  position: 'absolute',
  width: '100%',
};

const ACTIVE_TILE_CSS: SystemStyleObject = {
  outline: '2px solid {colors.accent.solid}',
  outlineOffset: '-4px',
};

// Tiles keep the default arrow like every other control; only full or unsupported ones say they won't pick.
const TILE_CSS: SystemStyleObject = { cursor: 'default' };
const INERT_TILE_CSS: SystemStyleObject = { cursor: 'not-allowed', opacity: 0.35 };

const getTileCss = (state: GalleryPickerTileState, isActive: boolean): SystemStyleObject => {
  const base = state === 'pickable' || state === 'added' ? TILE_CSS : INERT_TILE_CSS;

  return isActive ? { ...base, ...ACTIVE_TILE_CSS } : base;
};

export const galleryPickerOptionId = (idBase: string, key: GalleryItemKey): string => `${idBase}-${key}`;

const GalleryPickerTile = memo(function GalleryPickerTile({
  idBase,
  isActive,
  isCurrent,
  isMultiple,
  listingIndex,
  listingTotal,
  onReveal,
  shouldReveal,
  item,
  state,
}: {
  idBase: string;
  isActive: boolean;
  /** The Gallery widget's own selection, ringed so it reads as the default. */
  isCurrent: boolean;
  isMultiple: boolean;
  listingIndex: number;
  listingTotal: number | null;
  onReveal: () => void;
  shouldReveal: boolean;
  item: GalleryItem;
  state: GalleryPickerTileState;
}) {
  const { t } = useTranslation();
  const key = toGalleryItemKey(item);
  const css = useMemo(() => getTileCss(state, isActive), [isActive, state]);
  const unsupportedLabel =
    state === 'unsupported'
      ? t(item.kind === 'video' ? 'widgets.gallery.picker.unsupportedVideo' : 'widgets.gallery.picker.unsupportedImage')
      : undefined;

  const scrollIntoView = useCallback(
    (node: HTMLDivElement | null) => {
      if (node && shouldReveal) {
        node.scrollIntoView({ block: 'nearest' });
        onReveal();
      }
    },
    [onReveal, shouldReveal]
  );

  return (
    <GalleryTileFrame
      ref={scrollIntoView}
      aria-disabled={state === 'pickable' ? undefined : true}
      aria-label={state === 'added' ? t('widgets.gallery.picker.addedItem', { name: item.name }) : item.name}
      // Single mode: selection follows the highlight (what Enter picks).
      // Multiple mode: selection is what has been added; the highlight is
      // carried by `aria-activedescendant` alone.
      aria-selected={isMultiple ? state === 'added' : isActive}
      css={css}
      data-item-key={key}
      data-item-index={listingIndex}
      id={galleryPickerOptionId(idBase, key)}
      isSelected={isCurrent || state === 'added'}
      item={item}
      aria-posinset={listingIndex + 1}
      aria-setsize={listingTotal ?? -1}
      role="option"
      title={unsupportedLabel}
    >
      <img
        alt=""
        decoding="async"
        draggable={false}
        loading="lazy"
        src={item.thumbnailUrl || item.fullUrl}
        style={IMG_STYLE}
      />
      {state === 'added' ? (
        <Box
          alignItems="center"
          bg="accent.solid"
          boxSize="4"
          color="accent.contrast"
          display="flex"
          insetInlineEnd="1"
          justifyContent="center"
          pointerEvents="none"
          position="absolute"
          rounded="full"
          top="1"
          zIndex="1"
        >
          <Icon as={CheckIcon} boxSize="2.5" strokeWidth="3" />
        </Box>
      ) : null}
    </GalleryTileFrame>
  );
});

/**
 * Absolute virtual rows preserve the listing geometry while the range loader replaces distant pages.
 */
export const GalleryPickerGrid = ({
  activeIndex,
  columnCount,
  currentKey,
  getTileState,
  idBase,
  isMultiple,
  isStale,
  items,
  listing,
  label,
  onActivate,
  onColumnCountChange,
  onVisibleRangeChange,
  visibleRange,
}: {
  activeIndex: number;
  columnCount: number;
  currentKey: GalleryItemKey | null;
  getTileState: (item: GalleryItem) => GalleryPickerTileState;
  idBase: string;
  isMultiple: boolean;
  /** `items` belong to the previous scope while the current one loads. */
  isStale: boolean;
  /** Null while nothing has loaded yet. */
  items: GalleryItem[] | null;
  listing: {
    error: Error | null;
    itemsByIndex: ReadonlyMap<number, GalleryItem>;
    loadRange: (first: number, last: number) => void;
    offset: number;
    retry: () => void;
    total: number | null;
  };
  label: string;
  onActivate: (item: GalleryItem, index: number) => void;
  onColumnCountChange: (columnCount: number) => void;
  onVisibleRangeChange: (firstIndex: number, lastIndex: number) => void;
  visibleRange: { firstIndex: number; lastIndex: number } | null;
}) => {
  const { t } = useTranslation();
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [lastIndexItems, setLastIndexItems] = useState<ReadonlyMap<number, GalleryItem>>(() => new Map());
  const [rowPitch, setRowPitch] = useState(100);
  const [revealState, setRevealState] = useState({ activeIndex, pendingIndex: null as number | null });
  const itemsByIndex = isStale ? lastIndexItems : listing.itemsByIndex;

  // Preserve the dimmed previous scope while a new board/search is loading.
  if (!isStale && lastIndexItems !== listing.itemsByIndex) {
    setLastIndexItems(listing.itemsByIndex);
  }
  if (revealState.activeIndex !== activeIndex) {
    const isVisible =
      visibleRange !== null && activeIndex >= visibleRange.firstIndex && activeIndex <= visibleRange.lastIndex;
    setRevealState({ activeIndex, pendingIndex: activeIndex >= 0 && !isVisible ? activeIndex : null });
  }
  const pendingRevealIndex = revealState.activeIndex === activeIndex ? revealState.pendingIndex : null;
  const finishReveal = useCallback(() => {
    setRevealState((current) => ({ ...current, pendingIndex: null }));
  }, []);

  const attachViewport = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node;
  }, []);

  const measureRef = useCallback(
    (node: HTMLDivElement | null) => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;

      if (!node) {
        return;
      }

      const observer = new ResizeObserver(([entry]) => {
        const widthPx = entry?.contentRect.width ?? 0;

        if (widthPx > 0) {
          const columns = getGalleryColumnCountForCell({
            max: GALLERY_PICKER_MAX_COLUMNS,
            min: GALLERY_PICKER_MIN_COLUMNS,
            targetCellPx: GALLERY_PICKER_CELL_PX,
            widthPx,
          });
          onColumnCountChange(columns);
          setRowPitch((widthPx - GRID_GAP_PX * (columns - 1)) / columns + GRID_GAP_PX);
        }
      });

      observer.observe(node);
      resizeObserverRef.current = observer;
    },
    [onColumnCountChange]
  );

  const itemCount = useMemo(() => {
    if (listing.total !== null) {
      return listing.total;
    }

    let loadedEnd = listing.offset;
    for (const index of itemsByIndex.keys()) {
      loadedEnd = Math.max(loadedEnd, index + 1);
    }

    return Math.max(loadedEnd + UNKNOWN_TOTAL_TAIL, UNKNOWN_TOTAL_TAIL);
  }, [itemsByIndex, listing.offset, listing.total]);
  const rowCount = Math.ceil(itemCount / columnCount);
  const estimateRowSize = useCallback(() => rowPitch, [rowPitch]);
  const getRowKey = useCallback((index: number) => index, []);
  const getScrollElement = useCallback(() => viewportRef.current, []);
  // Keep the active descendant mounted; only a pending focus change scrolls it into view.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      const activeRow = activeIndex < 0 ? -1 : Math.floor(activeIndex / columnCount);

      if (activeRow < 0 || activeRow >= rowCount || indexes.includes(activeRow)) {
        return indexes;
      }

      return [...indexes, activeRow].sort((a, b) => a - b);
    },
    [activeIndex, columnCount, rowCount]
  );
  const virtualizer = useVirtualizer({
    count: rowCount,
    estimateSize: estimateRowSize,
    getItemKey: getRowKey,
    getScrollElement,
    overscan: VIRTUAL_OVERSCAN_ROWS,
    rangeExtractor,
    onChange: (instance) => {
      const range = instance.range;
      if (!range || isStale || itemCount === 0) {
        return;
      }

      const firstIndex = range.startIndex * columnCount;
      const lastIndex = Math.min(itemCount - 1, (range.endIndex + 1) * columnCount - 1);
      onVisibleRangeChange(firstIndex, lastIndex);
      listing.loadRange(firstIndex, lastIndex);
    },
    useFlushSync: false,
  });
  const virtualRows = virtualizer.virtualItems;
  const virtualHeight = virtualizer.totalSize;
  const handleRangeClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const index = Number((event.target as HTMLElement).closest<HTMLElement>('[data-item-index]')?.dataset.itemIndex);
      const item = Number.isInteger(index) ? itemsByIndex.get(index) : undefined;

      if (item) {
        onActivate(item, index);
      }
    },
    [itemsByIndex, onActivate]
  );

  return (
    <Scrollable flex="1" minH="0" viewportRef={attachViewport}>
      <Box p="2" opacity={isStale ? 0.6 : undefined} transition="opacity var(--wb-motion-duration-fast) ease">
        {items === null && listing.error ? (
          <Stack align="center" color="fg.muted" gap="2" justify="center" minH="7rem" px="4" py="6" role="alert">
            <Text fontSize="xs" textAlign="center">
              {listing.error.message}
            </Text>
            <Button size="xs" variant="outline" onClick={listing.retry}>
              {t('common.retry')}
            </Button>
          </Stack>
        ) : items === null ? (
          <Box
            ref={measureRef}
            aria-busy
            aria-label={label}
            aria-multiselectable={isMultiple || undefined}
            display="grid"
            gap={`${GRID_GAP_PX}px`}
            gridTemplateColumns={`repeat(${columnCount}, minmax(0, 1fr))`}
            id={idBase}
            role="listbox"
          >
            {Array.from({ length: SKELETON_TILE_COUNT }, (_, index) => (
              <Skeleton key={index} aspectRatio={1} rounded="md" />
            ))}
          </Box>
        ) : (
          <Box
            ref={measureRef}
            aria-busy={isStale || undefined}
            aria-label={label}
            aria-multiselectable={isMultiple || undefined}
            id={idBase}
            role="listbox"
            display="grid"
            gridTemplateColumns={`repeat(${columnCount}, minmax(0, 1fr))`}
            position="relative"
            height={`${virtualHeight}px`}
            onClick={handleRangeClick}
          >
            {virtualRows.map((row) => (
              <Box
                key={row.key}
                display="grid"
                gap={`${GRID_GAP_PX}px`}
                gridTemplateColumns={`repeat(${columnCount}, minmax(0, 1fr))`}
                insetInline={0}
                position="absolute"
                role="presentation"
                top={`${row.start}px`}
              >
                {Array.from({ length: columnCount }, (_, column) => {
                  const index = row.index * columnCount + column;
                  const item = itemsByIndex.get(index);

                  if (index >= itemCount) {
                    return null;
                  }

                  if (!item) {
                    return <Skeleton key={index} aspectRatio={1} rounded="md" />;
                  }

                  const key = toGalleryItemKey(item);
                  return (
                    <GalleryPickerTile
                      key={index}
                      idBase={idBase}
                      isActive={index === activeIndex}
                      isCurrent={key === currentKey}
                      isMultiple={isMultiple}
                      item={item}
                      state={getTileState(item)}
                      listingIndex={index}
                      listingTotal={listing.total}
                      shouldReveal={pendingRevealIndex === index}
                      onReveal={finishReveal}
                    />
                  );
                })}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </Scrollable>
  );
};
