import type { CanvasLayerContract, SemanticNode } from '@workbench/canvas-engine/api';
import type { LayerPanelDensity } from '@workbench/layerPanelState';
import type { FocusEvent, KeyboardEvent, MouseEvent } from 'react';

import { Badge, Box, HStack, Icon, Input, Stack, Text } from '@chakra-ui/react';
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
import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import type { LayerRowCommands } from './layerRowCommands';
import type { LayerTreeRow } from './layerTreeRows';

import { ControlLayerWarningIcon } from './ControlLayerWarningIcon';
import { recordLayerRowCommit } from './layerPanelDiagnostics';
import { LAYER_TREE_INDENT_PX } from './layerPanelRows';
import { anchorFromPoint, anchorFromRect } from './layerRowCommands';
import { layerRowSummary } from './layerRowSummary';
import { LayerThumbnail, type LayerThumbnailEngine } from './LayerThumbnail';

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

/**
 * One tree item. The row element itself carries the tree role, the roving tab stop and the
 * keyboard model; every control inside it is pointer-only (`tabIndex={-1}`) and reachable from the
 * keyboard through the row's menu, so the tree stays a single tab stop.
 */
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
  const rowElement = useRef<HTMLDivElement | null>(null);
  const setRowRef = useCallback(
    (element: HTMLDivElement | null) => {
      rowElement.current = element;
      setDragRef(element);
      setDropRef(element);
    },
    [setDragRef, setDropRef]
  );
  const nameInput = useRef<HTMLInputElement | null>(null);
  // Escape abandons the draft; the blur that follows refocusing the row must not commit it.
  const renameCancelled = useRef(false);

  useLayoutEffect(() => {
    recordLayerRowCommit(row.id);
  });

  const indentStyle = useMemo(() => ({ paddingLeft: `${vm.depth * LAYER_TREE_INDENT_PX}px` }), [vm.depth]);

  const handleSelect = useCallback(
    (event: MouseEvent<HTMLElement>) =>
      commands.select(row.id, { additive: event.metaKey || event.ctrlKey, range: event.shiftKey }),
    [commands, row.id]
  );
  const handleFocus = useCallback(() => commands.focus(row.id), [commands, row.id]);
  // A pressed control never takes focus from the tree item; the row it belongs to keeps the tab stop.
  const keepRowFocus = useCallback((event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    rowElement.current?.focus();
  }, []);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) {
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        commands.select(row.id, { additive: event.metaKey || event.ctrlKey, range: event.shiftKey });
        return;
      }
      commands.keyDown(row.id, event);
    },
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
      commands.openProperties(row.id);
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
  const finishRename = useCallback(
    (refocus: boolean) => {
      commands.endRename();
      if (refocus) {
        rowElement.current?.focus();
      }
    },
    [commands]
  );
  const commitName = useCallback(
    (refocus: boolean) => {
      const name = nameInput.current?.value.trim() ?? '';
      const cancelled = renameCancelled.current;
      finishRename(refocus);
      if (!cancelled && name && name !== node.name) {
        commands.rename(row.id, name);
      }
    },
    [commands, finishRename, node.name, row.id]
  );
  // Focus that dropped returns to the row. Focus that left for another element stays there, and is
  // set explicitly: committing unmounts the input while the browser is still moving focus, and that
  // move is dropped along with the input.
  const handleNameBlur = useCallback(
    (event: FocusEvent<HTMLInputElement>) => {
      const next = event.relatedTarget;
      // The window losing focus is not a decision; the draft waits for it to come back.
      if (next === null && !window.document.hasFocus()) {
        return;
      }
      commitName(next === null);
      if (next instanceof HTMLElement) {
        next.focus();
      }
    },
    [commitName]
  );
  const handleNameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        commitName(true);
      } else if (event.key === 'Escape') {
        renameCancelled.current = true;
        finishRename(true);
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

  // Pointer listeners only: the tree item owns its keyboard model; dnd-kit's keyboard activator,
  // roledescription and instructions stay out of the accessibility tree.
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
      aria-current={primary ? 'true' : undefined}
      aria-expanded={group ? row.expanded : undefined}
      aria-label={node.name}
      aria-level={vm.depth + 2}
      aria-posinset={row.posInSet}
      aria-selected={selected}
      aria-setsize={row.setSize}
      data-layer-row-id={row.id}
      data-primary={primary || undefined}
      h="full"
      opacity={drag ? 0.4 : undefined}
      role="treeitem"
      rounded="sm"
      tabIndex={focused ? 0 : -1}
      _focusVisible={ROW_SELECTION_FOCUS}
      onClick={handleSelect}
      onContextMenu={handleContextMenu}
      onDoubleClick={startRename}
      onFocus={handleFocus}
      onKeyDown={handleKeyDown}
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
        style={indentStyle}
        transition={LAYER_ROW_BACKGROUND_TRANSITION}
      >
        <HStack gap="1.5" h="full" w="full">
          {group ? (
            <IconButton
              aria-label={t(
                row.expanded ? 'widgets.layers.actions.collapseGroup' : 'widgets.layers.actions.expandGroup'
              )}
              color="fg.muted"
              size="2xs"
              tabIndex={-1}
              variant="ghost"
              onClick={handleToggleExpanded}
              onMouseDown={keepRowFocus}
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
                onBlur={handleNameBlur}
                onClick={stopPropagation}
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
                  <Text color="fg.muted" fontSize="2xs">
                    {vm.leafCount === 0
                      ? t('widgets.layers.groupEmpty')
                      : t('widgets.layers.groupSummary', { count: vm.leafCount })}
                  </Text>
                ) : (
                  <>
                    <Text color="fg.muted" fontSize="2xs" minW="0" truncate>
                      {layerRowSummary(layer!, t)}
                    </Text>
                    <ControlLayerWarningIcon contributing={vm.contributionEnabled} layer={layer!} />
                  </>
                )}
              </HStack>
            ) : null}
          </Stack>
          {/* One control cluster on the same rhythm as the stack header; slots a row cannot use are held open. */}
          <HStack flexShrink="0" gap="0.5" onClick={stopPropagation} onMouseDown={keepRowFocus}>
            {hideable ? (
              <Tooltip
                content={
                  hiddenByAncestor ? t('widgets.layers.actions.groupHidden') : t('widgets.layers.actions.toggleHidden')
                }
              >
                <IconButton
                  aria-label={t('widgets.layers.actions.toggleHidden')}
                  aria-pressed={!ownHidden}
                  color={vm.documentHidden ? 'fg.muted' : 'fg'}
                  disabled={editingLocked || hiddenByAncestor}
                  size="2xs"
                  tabIndex={-1}
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
            <Box display="flex" flexShrink="0" onPointerDown={stopPropagation}>
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
                tabIndex={-1}
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
                color={node.isLocked ? 'fg' : 'fg.muted'}
                disabled={editingLocked || lockedByAncestor}
                size="2xs"
                tabIndex={-1}
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
                color="fg.muted"
                disabled={editingLocked}
                size="2xs"
                tabIndex={-1}
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
              tabIndex={-1}
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
