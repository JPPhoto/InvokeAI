import type { GalleryItem, GalleryItemKey } from '@features/gallery';

import { Box, HStack } from '@chakra-ui/react';
import { useDraggable } from '@dnd-kit/core';
import { toGalleryItemKey, toGalleryItemRef } from '@features/gallery/contracts';
import { getGalleryItemDragData, getGalleryItemDragId } from '@features/gallery/utility';
import { Scrollable } from '@platform/ui/Scrollable';
import { useCallback, useMemo, type MouseEvent } from 'react';

import type { PreviewDensity } from './previewDensity';

/**
 * The current board's thumbnails as a row docked under the stage — the same
 * `boardImages` the Details position counter is derived from, made spatial.
 * It takes its own height rather than floating over the media, so the fitted
 * frame is never covered and Details has a clean edge to stop above. Thumbs
 * are standard all-image gallery-item drag sources, so they work with every
 * existing drop target (canvas zones, boards, drop-to-compare).
 */

export const PreviewFilmstrip = ({
  density,
  items,
  selectedItemKey,
  onCompare,
  onContextMenu,
  onSelect,
}: {
  density: PreviewDensity;
  items: GalleryItem[];
  selectedItemKey: GalleryItemKey | null;
  /** Alt-click: arm this thumb for comparison against the selection. */
  onCompare?: (item: GalleryItem) => void;
  /** Right-click: the image context menu for this thumb, at viewport coordinates. */
  onContextMenu?: (item: GalleryItem, x: number, y: number) => void;
  onSelect: (item: GalleryItem) => void;
}) => {
  const thumbSize = density === 'full' ? '12' : '8';

  if (items.length < 2) {
    return null;
  }

  return (
    // Two containment rules keep the strip honest: the ScrollArea root's
    // recipe defaults to `height: 100%`, so it MUST get an explicit height or
    // it swallows the widget; and `contain: inline-size` zeroes the strip's
    // intrinsic width so a long board can never stretch the widget wider than
    // its panel (side panels host widgets in a grid ScrollArea.Content that
    // otherwise grows to max-content).
    <Scrollable
      bg="bg.subtle"
      borderColor="border.subtle"
      borderTopWidth="1px"
      contentProps={FILMSTRIP_CONTENT_PROPS}
      css={FILMSTRIP_CONTAIN_CSS}
      data-preview-filmstrip
      flexShrink={0}
      h={density === 'full' ? '3.75rem' : '2.75rem'}
      minW="0"
      orientation="horizontal"
      px="2"
      w="full"
    >
      <HStack align="center" gap="1" h="full">
        {items.map((item) => {
          const itemKey = toGalleryItemKey(item);

          return (
            <FilmstripThumb
              key={itemKey}
              item={item}
              isSelected={itemKey === selectedItemKey}
              size={thumbSize}
              onCompare={onCompare}
              onContextMenu={onContextMenu}
              onSelect={onSelect}
            />
          );
        })}
      </HStack>
    </Scrollable>
  );
};

const FilmstripThumb = ({
  item,
  isSelected,
  size,
  onCompare,
  onContextMenu,
  onSelect,
}: {
  item: GalleryItem;
  isSelected: boolean;
  size: string;
  onCompare?: (item: GalleryItem) => void;
  onContextMenu?: (item: GalleryItem, x: number, y: number) => void;
  onSelect: (item: GalleryItem) => void;
}) => {
  const itemRef = useMemo(() => toGalleryItemRef(item), [item]);
  const dragData = useMemo(() => getGalleryItemDragData([itemRef]), [itemRef]);
  const thumbnailSrc = item.thumbnailUrl || (item.kind === 'image' ? item.fullUrl : null);
  const { isDragging, listeners, setNodeRef } = useDraggable({
    data: dragData,
    id: getGalleryItemDragId(itemRef, 'preview-filmstrip'),
  });
  const handleClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (event.altKey && onCompare) {
        onCompare(item);
        return;
      }

      onSelect(item);
    },
    [item, onCompare, onSelect]
  );
  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (onContextMenu) {
        event.preventDefault();
        onContextMenu(item, event.clientX, event.clientY);
      }
    },
    [item, onContextMenu]
  );
  // Ref callbacks re-run when `isSelected` changes, keeping the selected thumb
  // in view without an effect.
  const scrollIntoView = useCallback(
    (node: HTMLElement | null) => {
      setNodeRef(node);

      if (node && isSelected) {
        node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    },
    [isSelected, setNodeRef]
  );

  return (
    <Box
      ref={scrollIntoView}
      {...listeners}
      as="button"
      aria-current={isSelected || undefined}
      aria-label={item.kind === 'video' ? `Video ${item.name}` : item.name}
      borderColor={isSelected ? 'accent.solid' : 'border.subtle'}
      borderWidth="2px"
      boxSize={size}
      css={isDragging ? FILMSTRIP_THUMB_DRAG_CSS : FILMSTRIP_THUMB_ARMED_CSS}
      flexShrink={0}
      opacity={isDragging ? 0.4 : undefined}
      overflow="hidden"
      position="relative"
      rounded="sm"
      // Pan, don't drag: the strip scrolls horizontally, so a moving finger
      // must scroll it (the hold-to-drag sensor releases the gesture when the
      // browser claims it); dragging still works after a sustained hold.
      touchAction="pan-x"
      onClick={handleClick}
      onContextMenu={onContextMenu ? handleContextMenu : undefined}
    >
      {thumbnailSrc ? (
        <img alt={item.name} loading="lazy" src={thumbnailSrc} style={FILMSTRIP_IMG_STYLE} />
      ) : (
        <Box aria-hidden bg="bg.muted" h="full" w="full" />
      )}
    </Box>
  );
};

const FILMSTRIP_CONTAIN_CSS = { contain: 'inline-size' } as const;

/** Same touch drag cue as the gallery grid: the source thumb desaturates while dragged. */
const FILMSTRIP_THUMB_DRAG_CSS = { filter: 'saturate(0)' } as const;

/**
 * Same armed cue as the gallery grid: desaturation while a sustained touch
 * hold has armed the drag gate (before movement starts the drag). Set as
 * `data-drag-armed` by the hold-to-drag sensor.
 */
const FILMSTRIP_THUMB_ARMED_CSS = { '&[data-drag-armed=true]': { filter: 'saturate(0)' } } as const;

// The thumb row centers itself with `h="full"`, which needs the content
// wrapper to actually span the viewport height rather than shrink to it.
const FILMSTRIP_CONTENT_PROPS = { h: 'full' } as const;

const FILMSTRIP_IMG_STYLE = {
  display: 'block',
  height: '100%',
  objectFit: 'cover',
  width: '100%',
} as const;
