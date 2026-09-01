import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';

import { Box, HStack, Icon, Text } from '@chakra-ui/react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { Row } from '@platform/ui';
import { DropletIcon, GaugeIcon, ImageIcon, SplineIcon, SunMediumIcon, WavesIcon, type LucideIcon } from 'lucide-react';
import { memo, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import type { LayerRowCommands } from './layerRowCommands';

import { LayerActiveDot, ROW_SELECTION_FOCUS } from './LayerActiveDot';
import { isOrderedChildKind, type LayerChildRowKind, type ProjectedChildRow } from './layerChildRows';
import { LAYER_TREE_INDENT_PX } from './layerPanelRows';
import { anchorFromPoint } from './layerRowCommands';

const THUMBNAIL_IMG_STYLE: CSSProperties = { height: '100%', objectFit: 'cover', width: '100%' };

const CHILD_ROW_GLYPHS: Record<LayerChildRowKind, LucideIcon> = {
  'adjustment-brightness-contrast': SunMediumIcon,
  'adjustment-curves': SplineIcon,
  'adjustment-hsl': DropletIcon,
  'mask-denoise': GaugeIcon,
  'mask-noise': WavesIcon,
  'reference-image': ImageIcon,
};

/** Kinds whose rows can be picked up: reorderable entries and movable reference images. */
export const isDraggableChildKind = (kind: LayerChildRowKind): boolean =>
  kind === 'reference-image' || isOrderedChildKind(kind);

/** The row's display name; reference images are numbered, other modifiers named by kind. */
export const childRowName = (child: ProjectedChildRow, t: (key: string) => string): string => {
  switch (child.kind) {
    case 'reference-image':
      return `${t('widgets.layers.regionalGuidance.referenceImage')} ${child.posInSet}`;
    case 'mask-noise':
      return t('widgets.layers.modifiers.noise');
    case 'mask-denoise':
      return t('widgets.layers.modifiers.denoise');
    case 'adjustment-brightness-contrast':
      return t('widgets.layers.modifiers.brightnessContrast');
    case 'adjustment-hsl':
      return t('widgets.layers.adjustments.saturation');
    case 'adjustment-curves':
      return t('widgets.layers.adjustments.curves');
  }
};

interface LayerChildRowProps {
  child: ProjectedChildRow;
  commands: LayerRowCommands;
  /** The owning layer travels in the current drag; the row dims with it. */
  dimmed: boolean;
  dragDisabled: boolean;
  editingLocked: boolean;
  focused: boolean;
  selected: boolean;
}

/**
 * One projected child row: a modifier the layer above owns, on the tree's
 * roving tab stop. The dot toggles it, selecting it routes the Properties
 * pane to its editor, and Delete removes it; hide/lock do not apply. The row
 * registers a drop target so a layer drag over it lands below its owner.
 */
const LayerChildRowComponent = ({
  child,
  commands,
  dimmed,
  dragDisabled,
  editingLocked,
  focused,
  selected,
}: LayerChildRowProps) => {
  const { t } = useTranslation();
  const rowElement = useRef<HTMLDivElement | null>(null);
  const { setNodeRef: setDropRef } = useDroppable({
    data: { stack: child.stack },
    disabled: dragDisabled,
    id: child.key,
  });
  const { listeners, setNodeRef: setDragRef } = useDraggable({
    data: { stack: child.stack },
    disabled: dragDisabled || !isDraggableChildKind(child.kind),
    id: child.key,
  });
  const setRowRef = useCallback(
    (element: HTMLDivElement | null) => {
      rowElement.current = element;
      setDropRef(element);
      setDragRef(element);
    },
    [setDragRef, setDropRef]
  );
  // Pointer listeners only, like layer rows: the tree owns the keyboard model.
  const dragListeners = useMemo(() => {
    if (dragDisabled || !listeners) {
      return {};
    }
    const { onKeyDown: _onKeyDown, ...rest } = listeners;
    return rest;
  }, [dragDisabled, listeners]);
  const name = childRowName(child, t);

  const indentStyle = useMemo(() => ({ paddingLeft: `${child.depth * LAYER_TREE_INDENT_PX}px` }), [child.depth]);
  const handleSelect = useCallback(() => commands.selectChild(child), [child, commands]);
  const handleFocus = useCallback(() => commands.focus(child.key), [child.key, commands]);
  const keepRowFocus = useCallback((event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    rowElement.current?.focus();
  }, []);
  const handleToggle = useCallback((checked: boolean) => commands.setChildEnabled(child, checked), [child, commands]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) {
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        commands.selectChild(child);
        return;
      }
      commands.keyDown(child.key, event);
    },
    [child, commands]
  );
  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      if (!selected) {
        commands.selectChild(child, { reveal: false });
      }
      commands.openChildMenu(child, anchorFromPoint(event.clientX, event.clientY));
    },
    [child, commands, selected]
  );

  const muted = !child.isEnabled || !child.parentContributing;

  return (
    <Box
      ref={setRowRef}
      {...dragListeners}
      aria-label={name}
      aria-level={child.depth + 2}
      aria-posinset={child.posInSet}
      aria-selected={selected}
      aria-setsize={child.setSize}
      data-layer-row-id={child.key}
      h="full"
      opacity={dimmed ? 0.4 : undefined}
      pb="0.5"
      role="treeitem"
      rounded="sm"
      tabIndex={focused ? 0 : -1}
      _focusVisible={ROW_SELECTION_FOCUS}
      onClick={handleSelect}
      onContextMenu={handleContextMenu}
      onFocus={handleFocus}
      onKeyDown={handleKeyDown}
    >
      <Row
        active={selected ? 'emphasized' : undefined}
        alignItems="center"
        display="flex"
        gap="1.5"
        h="full"
        px="1.5"
        style={indentStyle}
      >
        <LayerActiveDot
          checked={child.isEnabled}
          disabled={editingLocked}
          gated={!child.parentContributing}
          label={t('widgets.layers.modifiers.toggleActive')}
          tooltip={child.parentContributing ? undefined : t('widgets.layers.modifiers.parentDisabled')}
          onCheckedChange={handleToggle}
          onKeepRowFocus={keepRowFocus}
        />
        <Box
          alignItems="center"
          bg="bg.muted"
          borderColor="border.subtle"
          borderWidth="1px"
          boxSize="6"
          color="fg.muted"
          display="flex"
          flexShrink={0}
          justifyContent="center"
          overflow="hidden"
          rounded="sm"
        >
          {child.image ? (
            <img alt="" draggable={false} src={child.image.thumbnailUrl} style={THUMBNAIL_IMG_STYLE} />
          ) : (
            <Icon as={CHILD_ROW_GLYPHS[child.kind]} boxSize="3" />
          )}
        </Box>
        <Text color={muted ? 'fg.muted' : undefined} flex="1" fontSize="2xs" fontWeight="600" minW="0" truncate>
          {name}
        </Text>
        {child.value !== null ? (
          <Text color="fg.subtle" flexShrink={0} fontSize="2xs" fontVariantNumeric="tabular-nums">
            {`${Math.round(child.value * 100)}%`}
          </Text>
        ) : null}
      </Row>
    </Box>
  );
};

export const LayerChildRow = memo(LayerChildRowComponent);

/** The compact card that follows the pointer while a child row is dragged. */
export const ChildDragGhost = ({ child }: { child: ProjectedChildRow }) => {
  const { t } = useTranslation();
  return (
    <HStack
      bg="bg.panel"
      borderColor="accent.solid"
      borderWidth="1px"
      boxShadow="lg"
      cursor="grabbing"
      gap="2"
      maxW="14rem"
      px="2"
      py="1"
      rounded="sm"
    >
      <Icon as={CHILD_ROW_GLYPHS[child.kind]} boxSize="3" color="fg.muted" flexShrink={0} />
      <Text fontSize="2xs" fontWeight="700" truncate>
        {childRowName(child, t)}
      </Text>
    </HStack>
  );
};
