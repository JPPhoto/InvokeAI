import type { CanvasLayerContract, SemanticNode } from '@workbench/canvas-engine/api';
import type { LayerPanelDensity } from '@workbench/layerPanelState';
import type { KeyboardEvent, MouseEvent } from 'react';

import { Badge, Box, chakra, HStack, Icon, Input, Stack, Text } from '@chakra-ui/react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { IconButton, Row, ToggleDot, Tooltip } from '@platform/ui';
import { MiddleTruncate } from '@platform/ui/MiddleTruncate';
import { isHideableLayer, isNodeHidden, isOverlayStack } from '@workbench/canvas-engine/api';
import {
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  FolderOpenIcon,
  ImageIcon,
  LockIcon,
  LockOpenIcon,
  MoreVerticalIcon,
  SlidersHorizontalIcon,
} from 'lucide-react';
import { memo, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import type { LayerRowCommands } from './layerRowCommands';
import type { LayerTreeRow } from './layerTreeRows';

import { ControlLayerWarningIcon } from './ControlLayerWarningIcon';
import { LAYER_TREE_INDENT_PX } from './layerPanelRows';
import { anchorFromPoint, anchorFromRect } from './layerRowCommands';
import { layerRowSummary } from './layerRowSummary';
import { LayerThumbnail, type LayerThumbnailEngine } from './LayerThumbnail';

const ROW_INTERACTIVE_DESCENDANTS = { '& button, & input': { pointerEvents: 'auto' } };
const ROW_SELECTION_FOCUS = { outline: '2px solid', outlineColor: 'accent.solid', outlineOffset: '-2px' };
const LAYER_ROW_BACKGROUND_TRANSITION = 'background min(40ms, var(--wb-motion-duration-fast)) ease-out';
const VISIBILITY_DOT_BASE = {
  borderRadius: 'full',
  borderWidth: '1px',
  content: '""',
  h: '3',
  inset: '50% auto auto 50%',
  position: 'absolute',
  transform: 'translate(-50%, -50%)',
  transition: 'background var(--wb-motion-duration-fast), border-color var(--wb-motion-duration-fast)',
  w: '3',
};
const VISIBILITY_DOT_CHECKED = { ...VISIBILITY_DOT_BASE, bg: 'accent.solid', borderColor: 'accent.solid' };
/** Enabled on its own, but an ancestor keeps it out of the composite. */
const VISIBILITY_DOT_GATED = { ...VISIBILITY_DOT_BASE, bg: 'transparent', borderColor: 'accent.solid' };
const VISIBILITY_DOT_UNCHECKED = { ...VISIBILITY_DOT_BASE, bg: 'transparent', borderColor: 'border.emphasized' };
const VISIBILITY_DOT_CHECKED_HOVER = { _before: { bg: 'accent.emphasized', borderColor: 'accent.emphasized' } };
const VISIBILITY_DOT_UNCHECKED_HOVER = { _before: { borderColor: 'fg.muted' } };

const THUMBNAIL_SIZE: Record<LayerPanelDensity, string> = { comfortable: '8', compact: '5', large: '11' };
const NAME_SIZE: Record<LayerPanelDensity, string> = { comfortable: '2xs', compact: '2xs', large: 'xs' };

/** How a row takes part in the current drag. */
export type LayerRowDragState = 'source' | 'travelling' | null;

interface LayerRowProps {
  commands: LayerRowCommands;
  density: LayerPanelDensity;
  drag: LayerRowDragState;
  /** Drag reordering is off: the editing lock or degraded mode. */
  dragDisabled: boolean;
  editingLocked: boolean;
  engine: LayerThumbnailEngine | null;
  focused: boolean;
  primary: boolean;
  renaming: boolean;
  row: LayerTreeRow;
  selected: boolean;
  /** Thumbnails are drawn; off in degraded mode. */
  thumbnails: boolean;
}

const stopPropagation = (event: { stopPropagation: () => void }): void => event.stopPropagation();

const LayerRowComponent = ({
  commands,
  density,
  drag,
  dragDisabled,
  editingLocked,
  engine,
  focused,
  primary,
  renaming,
  row,
  selected,
  thumbnails,
}: LayerRowProps) => {
  const { t } = useTranslation();
  const { vm } = row;
  const { node } = vm;
  const group = vm.kind === 'group';
  const layer = group ? null : (node as CanvasLayerContract);
  const { listeners, setNodeRef: setDragRef } = useDraggable({
    data: { stack: vm.stack },
    disabled: dragDisabled,
    id: row.id,
  });
  const { setNodeRef: setDropRef } = useDroppable({ data: { stack: vm.stack }, disabled: dragDisabled, id: row.id });
  const setRowRef = useCallback(
    (element: HTMLElement | null) => {
      setDragRef(element);
      setDropRef(element);
    },
    [setDragRef, setDropRef]
  );
  const nameInput = useRef<HTMLInputElement | null>(null);
  // Escape abandons the draft; the blur that follows refocusing the row must not commit it.
  const renameCancelled = useRef(false);
  const treeItem = useRef<HTMLButtonElement | null>(null);

  const indentStyle = useMemo(() => ({ paddingLeft: `${vm.depth * LAYER_TREE_INDENT_PX}px` }), [vm.depth]);

  const handleSelect = useCallback(
    (event: MouseEvent<HTMLButtonElement>) =>
      commands.select(row.id, { additive: event.metaKey || event.ctrlKey, range: event.shiftKey }),
    [commands, row.id]
  );
  const handleFocus = useCallback(() => commands.focus(row.id), [commands, row.id]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => commands.keyDown(row.id, event),
    [commands, row.id]
  );
  const handleToggleExpanded = useCallback(
    (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      commands.toggleExpanded(row.id);
    },
    [commands, row.id]
  );
  const handleToggleVisible = useCallback(
    (checked: boolean) => commands.setEnabled(row.id, checked),
    [commands, row.id]
  );
  const handleToggleHidden = useCallback(
    (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      commands.setHidden(row.id, !isNodeHidden(node));
    },
    [commands, node, row.id]
  );
  const handleToggleLock = useCallback(
    (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      commands.setLocked(row.id, !node.isLocked);
    },
    [commands, node.isLocked, row.id]
  );
  const handleOpenMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      commands.openMenu(row.id, anchorFromRect(event.currentTarget.getBoundingClientRect()));
    },
    [commands, row.id]
  );
  const handleOpenProperties = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      commands.openProperties(row.id, anchorFromRect(event.currentTarget.getBoundingClientRect()));
    },
    [commands, row.id]
  );
  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      if (!selected) {
        commands.select(row.id, { additive: false, range: false });
      }
      commands.openMenu(row.id, anchorFromPoint(event.clientX, event.clientY));
    },
    [commands, row.id, selected]
  );
  const startRename = useCallback(() => {
    if (!editingLocked) {
      commands.startRename(row.id);
    }
  }, [commands, editingLocked, row.id]);
  const finishRename = useCallback(() => {
    commands.endRename();
    treeItem.current?.focus();
  }, [commands]);
  const commitName = useCallback(() => {
    const name = nameInput.current?.value.trim() ?? '';
    const cancelled = renameCancelled.current;
    finishRename();
    if (!cancelled && name && name !== node.name) {
      commands.rename(row.id, name);
    }
  }, [commands, finishRename, node.name, row.id]);
  const handleNameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.stopPropagation();
        commitName();
      } else if (event.key === 'Escape') {
        event.stopPropagation();
        renameCancelled.current = true;
        finishRename();
      }
    },
    [commitName, finishRename]
  );
  const focusOnMount = useCallback((input: HTMLInputElement | null) => {
    nameInput.current = input;
    renameCancelled.current = false;
    input?.focus();
    input?.select();
  }, []);

  // Pointer listeners only: the tree item owns its role, focus and keyboard model, and dnd-kit's
  // keyboard activator, roledescription and instructions stay out of the accessibility tree.
  const dragListeners = useMemo(() => {
    if (dragDisabled || !listeners) {
      return {};
    }
    const { onKeyDown: _onKeyDown, ...rest } = listeners;
    return rest;
  }, [dragDisabled, listeners]);

  const hideable = group ? isOverlayStack(vm.stack) : isHideableLayer(layer!);
  const ownHidden = isNodeHidden(node);
  const hiddenByAncestor = vm.documentHidden && !ownHidden;
  const lockedByAncestor = vm.effectiveLocked && !node.isLocked;
  const disabledByAncestor = !vm.contributionEnabled && node.isEnabled;

  return (
    <Box
      ref={setRowRef}
      {...dragListeners}
      data-layer-row-id={row.id}
      h="full"
      opacity={drag ? 0.4 : undefined}
      onContextMenu={handleContextMenu}
    >
      <Row
        active={selected ? 'muted' : undefined}
        borderStartColor={primary ? 'accent.solid' : 'transparent'}
        borderStartWidth="2px"
        cursor={drag === 'source' ? 'grabbing' : 'default'}
        display="flex"
        gap="1.5"
        h="full"
        px="1.5"
        position="relative"
        style={indentStyle}
        transition={LAYER_ROW_BACKGROUND_TRANSITION}
      >
        {/* No grip: the whole row is the pointer drag target; this row-covering button is the tree item. */}
        <chakra.button
          ref={treeItem}
          aria-current={primary ? 'true' : undefined}
          aria-expanded={group ? row.expanded : undefined}
          aria-label={t('widgets.layers.actions.select', { name: node.name })}
          aria-level={vm.depth + 1}
          aria-posinset={row.posInSet}
          aria-selected={selected}
          aria-setsize={row.setSize}
          data-primary={primary || undefined}
          inset="0"
          position="absolute"
          role="treeitem"
          rounded="sm"
          tabIndex={focused ? 0 : -1}
          type="button"
          _focusVisible={ROW_SELECTION_FOCUS}
          onClick={handleSelect}
          onDoubleClick={startRename}
          onFocus={handleFocus}
          onKeyDown={handleKeyDown}
        />
        <HStack css={ROW_INTERACTIVE_DESCENDANTS} gap="1.5" h="full" pointerEvents="none" position="relative" w="full">
          {group ? (
            <IconButton
              aria-label={t(
                row.expanded ? 'widgets.layers.actions.collapseGroup' : 'widgets.layers.actions.expandGroup'
              )}
              color="fg.subtle"
              size="2xs"
              variant="ghost"
              onClick={handleToggleExpanded}
              onPointerDown={stopPropagation}
            >
              <Icon
                as={ChevronRightIcon}
                boxSize="3.5"
                transform={row.expanded ? 'rotate(90deg)' : undefined}
                transitionDuration="fast"
                transitionProperty="transform"
              />
            </IconButton>
          ) : null}
          {group || !thumbnails ? (
            <Box
              alignItems="center"
              bg="bg.muted"
              borderColor="border.subtle"
              borderWidth="1px"
              boxSize={THUMBNAIL_SIZE[density]}
              color="fg.muted"
              display="flex"
              flexShrink={0}
              justifyContent="center"
              rounded="sm"
            >
              <Icon as={group ? (row.expanded ? FolderOpenIcon : FolderIcon) : ImageIcon} boxSize="4" />
            </Box>
          ) : (
            <Box boxSize={THUMBNAIL_SIZE[density]} flexShrink={0}>
              <LayerThumbnail engine={engine} layer={layer!} />
            </Box>
          )}
          <Stack flex="1" gap="0" justify="center" minW="0">
            {renaming ? (
              <Input
                ref={focusOnMount}
                aria-label={t('widgets.layers.actions.rename')}
                defaultValue={node.name}
                size="2xs"
                onBlur={commitName}
                onKeyDown={handleNameKeyDown}
                onPointerDown={stopPropagation}
              />
            ) : (
              <MiddleTruncate
                color={vm.contributionEnabled ? undefined : 'fg.muted'}
                fontSize={NAME_SIZE[density]}
                fontWeight="700"
                text={node.name}
              />
            )}
            {density !== 'compact' ? (
              <HStack gap="1" minW="0">
                {group ? (
                  <Text color="fg.subtle" fontSize="2xs">
                    {vm.leafCount === 0
                      ? t('widgets.layers.groupEmpty')
                      : t('widgets.layers.groupSummary', { count: vm.leafCount })}
                  </Text>
                ) : (
                  <>
                    <Text color="fg.subtle" fontSize="2xs" minW="0" truncate>
                      {layerRowSummary(layer!, t)}
                    </Text>
                    <ControlLayerWarningIcon contributing={vm.contributionEnabled} layer={layer!} />
                  </>
                )}
              </HStack>
            ) : null}
          </Stack>
          {/* One control cluster on the same rhythm as the stack header; slots a row cannot use are held open. */}
          <HStack flexShrink="0" gap="0.5">
            {hideable ? (
              <Tooltip
                content={
                  hiddenByAncestor ? t('widgets.layers.actions.groupHidden') : t('widgets.layers.actions.toggleHidden')
                }
              >
                <IconButton
                  aria-label={t('widgets.layers.actions.toggleHidden')}
                  aria-pressed={!ownHidden}
                  color={vm.documentHidden ? 'fg.subtle' : 'fg'}
                  disabled={editingLocked || hiddenByAncestor}
                  size="2xs"
                  variant="ghost"
                  onClick={handleToggleHidden}
                  onPointerDown={stopPropagation}
                >
                  {vm.documentHidden ? <EyeOffIcon /> : <EyeIcon />}
                </IconButton>
              </Tooltip>
            ) : (
              <Box boxSize="6" />
            )}
            <Box display="flex" flexShrink="0" onClick={stopPropagation} onPointerDown={stopPropagation}>
              <ToggleDot
                _before={
                  node.isEnabled
                    ? disabledByAncestor
                      ? VISIBILITY_DOT_GATED
                      : VISIBILITY_DOT_CHECKED
                    : VISIBILITY_DOT_UNCHECKED
                }
                _focusVisible={ROW_SELECTION_FOCUS}
                _hover={node.isEnabled ? VISIBILITY_DOT_CHECKED_HOVER : VISIBILITY_DOT_UNCHECKED_HOVER}
                bg="transparent"
                borderWidth="0"
                checked={node.isEnabled}
                cursor={editingLocked ? 'not-allowed' : 'pointer'}
                disabled={editingLocked}
                h="6"
                label={t('widgets.layers.actions.toggleVisibility')}
                position="relative"
                tooltip={disabledByAncestor ? t('widgets.layers.actions.groupDisabled') : undefined}
                transition="none"
                w="6"
                onCheckedChange={handleToggleVisible}
              />
            </Box>
            <Tooltip
              content={
                lockedByAncestor ? t('widgets.layers.actions.groupLocked') : t('widgets.layers.actions.toggleLock')
              }
            >
              <IconButton
                aria-label={t('widgets.layers.actions.toggleLock')}
                color={node.isLocked ? 'fg' : vm.effectiveLocked ? 'fg.muted' : 'fg.subtle'}
                disabled={editingLocked || lockedByAncestor}
                size="2xs"
                variant="ghost"
                onClick={handleToggleLock}
                onPointerDown={stopPropagation}
              >
                {vm.effectiveLocked ? <LockIcon /> : <LockOpenIcon />}
              </IconButton>
            </Tooltip>
            {layer ? (
              <IconButton
                aria-label={t('widgets.layers.properties')}
                color="fg.subtle"
                disabled={editingLocked}
                size="2xs"
                variant="ghost"
                onClick={handleOpenProperties}
                onPointerDown={stopPropagation}
              >
                <SlidersHorizontalIcon />
              </IconButton>
            ) : (
              <Box boxSize="6" />
            )}
            <IconButton
              aria-label={t('widgets.layers.options')}
              color="fg.muted"
              size="2xs"
              variant="ghost"
              onClick={handleOpenMenu}
              onPointerDown={stopPropagation}
            >
              <MoreVerticalIcon />
            </IconButton>
          </HStack>
        </HStack>
      </Row>
    </Box>
  );
};

export const LayerRow = memo(LayerRowComponent);

/** The compact card that follows the pointer: the grabbed row's name plus how many rows travel. */
export const LayerDragGhost = ({ count, vm }: { count: number; vm: SemanticNode }) => (
  <HStack
    bg="bg.panel"
    borderColor="accent.solid"
    borderWidth="1px"
    boxShadow="lg"
    cursor="grabbing"
    gap="2"
    maxW="16rem"
    px="2"
    py="1.5"
    rounded="sm"
  >
    {vm.kind === 'group' ? <Icon as={FolderIcon} boxSize="3.5" color="fg.muted" flexShrink={0} /> : null}
    <Text flex="1" fontSize="2xs" fontWeight="700" truncate>
      {vm.node.name}
    </Text>
    {count > 1 ? (
      <Badge colorPalette="accent" size="xs" variant="solid">
        {count}
      </Badge>
    ) : null}
  </HStack>
);
