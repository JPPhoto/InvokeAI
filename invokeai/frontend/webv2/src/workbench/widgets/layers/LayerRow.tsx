import type { CanvasGroupContract, CanvasLayerContract } from '@workbench/canvas-engine/api';
import type { CanvasProjectMutation } from '@workbench/canvasProjectMutations';
import type { LayerSelectionModifiers } from '@workbench/layerPanelState';
import type { CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';
import type { Dispatch, KeyboardEvent, MouseEvent } from 'react';

import { Badge, Box, chakra, HStack, Icon, Input, Stack, Text } from '@chakra-ui/react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { IconButton, Row, ToggleDot, Tooltip } from '@platform/ui';
import { MiddleTruncate } from '@platform/ui/MiddleTruncate';
import { isHideableLayer, isNodeHidden, isOverlayStack } from '@workbench/canvas-engine/api';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import {
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  FolderOpenIcon,
  LockIcon,
  LockOpenIcon,
} from 'lucide-react';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { LayerTreeRow } from './layerTreeRows';

import { ControlLayerWarningIcon } from './ControlLayerWarningIcon';
import {
  CanvasLayerContextMenu,
  type CanvasLayerContextMenuTarget,
  LayerContextMenu,
  type LayerContextMenuEngine,
} from './LayerContextMenu';
import { LayerGroupContextMenu, type LayerGroupContextMenuEngine } from './LayerGroupContextMenu';
import { createLayerMenuTargetFromContextEvent } from './layerMenuState';
import { LayerPropertiesPopover, type LayerPropertiesEngine } from './LayerPropertiesPopover';
import { LayerThumbnail } from './LayerThumbnail';

/** Horizontal offset per nesting level, in CSS pixels; the drag projection uses the same step. */
export const LAYER_TREE_INDENT_PX = 16;

const ROW_INTERACTIVE_DESCENDANTS = {
  '& button, & input': {
    pointerEvents: 'auto',
  },
};
const ROW_SELECTION_FOCUS = {
  outline: '2px solid',
  outlineColor: 'accent.solid',
  outlineOffset: '-2px',
};
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
const INDICATOR_STYLE = { bg: 'accent.solid', borderRadius: 'full', h: '2px', my: '1px' };

export type LayerRowEngine = LayerContextMenuEngine &
  LayerGroupContextMenuEngine &
  LayerPropertiesEngine &
  Pick<CanvasEngineHandle, 'previews'>;

const layerBadgeKey = (layer: CanvasLayerContract): string => {
  if (layer.type === 'raster') {
    return layer.source.type === 'image' ? 'widgets.layers.types.image' : 'widgets.layers.types.paint';
  }
  return `widgets.layers.types.${layer.type}`;
};

export interface LayerRowDragState {
  /** The row travels with the current drag. */
  readonly isDragSource: boolean;
  /** The row stands in for the dragged block: draw the insertion line at this depth instead. */
  readonly indicatorDepth: number | null;
}

interface LayerRowProps {
  dispatch: Dispatch<CanvasProjectMutation>;
  drag: LayerRowDragState | null;
  editingLocked: boolean;
  engine: LayerRowEngine | null;
  isPrimarySelected: boolean;
  isSelected: boolean;
  row: LayerTreeRow;
  onSelect: (id: string, modifiers: LayerSelectionModifiers) => void;
  onToggleExpanded: (groupId: string) => void;
}

export const getLayerRowInteractionState = (editingLocked: boolean) => ({
  canRename: !editingLocked,
  canSelect: true,
  canToggleLock: !editingLocked,
  canToggleVisibility: !editingLocked,
  sortableDisabled: editingLocked,
});

const stopPropagation = (event: { stopPropagation: () => void }): void => event.stopPropagation();

const LayerRowComponent = ({
  dispatch,
  drag,
  editingLocked,
  engine,
  isPrimarySelected,
  isSelected,
  row,
  onSelect,
  onToggleExpanded,
}: LayerRowProps) => {
  const commitPrepared = usePreparedCommit(engine);
  const { t } = useTranslation();
  const interaction = getLayerRowInteractionState(editingLocked);
  const { node } = row;
  const group = node.type === 'group' ? (node as CanvasGroupContract) : null;
  const layer = node.type === 'group' ? null : (node as CanvasLayerContract);
  const { attributes, isDragging, listeners, setActivatorNodeRef, setNodeRef, transform, transition } = useSortable({
    disabled: interaction.sortableDisabled,
    id: row.id,
  });
  const [isEditing, setIsEditing] = useState(false);
  const [draftName, setDraftName] = useState(node.name);
  const [contextMenuTarget, setContextMenuTarget] = useState<CanvasLayerContextMenuTarget | null>(null);
  const [groupMenuAnchor, setGroupMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const selectRef = useRef<HTMLButtonElement | null>(null);

  const dndStyle = useMemo(
    () => ({
      opacity: isDragging || drag?.isDragSource ? 0.4 : undefined,
      position: 'relative' as const,
      transform: CSS.Translate.toString(transform),
      transition,
      zIndex: isDragging ? 1 : undefined,
    }),
    [drag?.isDragSource, isDragging, transform, transition]
  );
  const indentStyle = useMemo(() => ({ paddingLeft: `${row.depth * LAYER_TREE_INDENT_PX}px` }), [row.depth]);
  // The insertion line stands in for the block at full strength; only the block itself fades.
  const indicatorHostStyle = useMemo(() => ({ ...dndStyle, opacity: undefined }), [dndStyle]);
  const indicatorStyle = useMemo(
    () => ({ marginLeft: `${(drag?.indicatorDepth ?? 0) * LAYER_TREE_INDENT_PX}px` }),
    [drag?.indicatorDepth]
  );

  const handleSelect = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (interaction.canSelect) {
        onSelect(row.id, { additive: event.metaKey || event.ctrlKey, range: event.shiftKey });
      }
    },
    [interaction.canSelect, row.id, onSelect]
  );

  const handleToggleExpanded = useCallback(
    (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      onToggleExpanded(row.id);
    },
    [onToggleExpanded, row.id]
  );

  const handleSelectKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const tree = event.currentTarget.closest('[role="tree"]');
        const items = tree ? Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]')) : [];
        const next = items[items.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1)];
        if (next) {
          event.preventDefault();
          next.focus();
        }
        return;
      }
      if (!group) {
        return;
      }
      if ((event.key === 'ArrowRight' && !row.expanded) || (event.key === 'ArrowLeft' && row.expanded)) {
        event.preventDefault();
        onToggleExpanded(row.id);
      }
    },
    [group, onToggleExpanded, row.expanded, row.id]
  );

  const patchBase = useCallback(
    (label: string, forward: Partial<Pick<CanvasLayerContract, 'name' | 'isEnabled' | 'isLocked'>>) => {
      commitPrepared(label, (model) => model.prepare({ id: row.id, patch: forward, type: 'patch' }));
    },
    [commitPrepared, row.id]
  );

  const handleToggleVisible = useCallback(
    (checked: boolean) => patchBase(t('widgets.layers.actions.toggleVisibility'), { isEnabled: checked }),
    [patchBase, t]
  );

  const handleToggleHidden = useCallback(
    (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      const isHidden = !isNodeHidden(node);
      commitPrepared(t('widgets.layers.actions.toggleHidden'), (model) =>
        model.prepare({ type: 'set-hidden', updates: [{ id: row.id, isHidden }] })
      );
    },
    [commitPrepared, node, row.id, t]
  );

  const handleToggleLock = useCallback(
    (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      patchBase(t('widgets.layers.actions.toggleLock'), { isLocked: !node.isLocked });
    },
    [node.isLocked, patchBase, t]
  );

  const startEditing = useCallback(() => {
    setDraftName(node.name);
    setIsEditing(true);
  }, [node.name]);

  const finishEditing = useCallback(() => {
    setIsEditing(false);
    selectRef.current?.focus();
  }, []);

  const commitName = useCallback(() => {
    finishEditing();
    const name = draftName.trim();
    if (name && name !== node.name) {
      patchBase(t('widgets.layers.actions.rename'), { name });
    }
  }, [draftName, finishEditing, node.name, patchBase, t]);

  const handleNameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      // Stop only the two keys the rename owns; the hotkey runtime already refuses non-editable
      // bindings for a focused input, and Escape would otherwise reach the engine as a deselect.
      if (event.key === 'Enter') {
        event.stopPropagation();
        commitName();
      } else if (event.key === 'Escape') {
        event.stopPropagation();
        finishEditing();
      }
    },
    [commitName, finishEditing]
  );

  const handleNameChange = useCallback((event: { target: { value: string } }) => setDraftName(event.target.value), []);
  const focusOnMount = useCallback((input: HTMLInputElement | null) => {
    input?.focus();
    input?.select();
  }, []);

  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (!isSelected) {
        onSelect(row.id, { additive: false, range: false });
      }
      if (layer) {
        setContextMenuTarget(createLayerMenuTargetFromContextEvent(row.id, event));
      } else {
        event.preventDefault();
        setGroupMenuAnchor({ x: event.clientX, y: event.clientY });
      }
    },
    [isSelected, layer, onSelect, row.id]
  );

  const closeContextMenu = useCallback(() => setContextMenuTarget(null), []);
  const closeGroupMenu = useCallback(() => setGroupMenuAnchor(null), []);
  const setSelectRef = useCallback(
    (element: HTMLButtonElement | null) => {
      setActivatorNodeRef(element);
      selectRef.current = element;
    },
    [setActivatorNodeRef]
  );

  // Pointer listeners only: Enter on a row belongs to selection, and keyboard reordering is the
  // menu's Move actions, so dnd-kit's keyboard activator stays unattached.
  const sortableRowListeners = useMemo(() => {
    if (interaction.sortableDisabled || !listeners) {
      return {};
    }
    const { onKeyDown: _onKeyDown, ...rest } = listeners;
    return rest;
  }, [interaction.sortableDisabled, listeners]);

  // The selection button owns its role, focus, and pressed state.
  const sortableAttributes = useMemo(() => {
    if (interaction.sortableDisabled) {
      return {};
    }
    const { role: _role, tabIndex: _tabIndex, 'aria-pressed': _ariaPressed, ...rest } = attributes;
    return rest;
  }, [attributes, interaction.sortableDisabled]);

  const hideable = group ? isOverlayStack(row.stack) : isHideableLayer(layer!);
  const ownHidden = isNodeHidden(node);
  const hiddenByAncestor = row.documentHidden && !ownHidden;
  const lockedByAncestor = row.effectiveLocked && !node.isLocked;
  const disabledByAncestor = !row.contributionEnabled && node.isEnabled;

  if (drag?.indicatorDepth !== null && drag?.indicatorDepth !== undefined) {
    return (
      <Box ref={setNodeRef} aria-hidden style={indicatorHostStyle}>
        <Box style={indicatorStyle} {...INDICATOR_STYLE} />
      </Box>
    );
  }

  return (
    <Box ref={setNodeRef} style={dndStyle}>
      <Row
        {...sortableRowListeners}
        active={isSelected ? 'muted' : undefined}
        borderStartColor={isPrimarySelected ? 'accent.solid' : 'transparent'}
        borderStartWidth="2px"
        cursor={isDragging ? 'grabbing' : 'default'}
        display="flex"
        gap="1.5"
        p="1.5"
        position="relative"
        style={indentStyle}
        transition={LAYER_ROW_BACKGROUND_TRANSITION}
        onContextMenu={handleContextMenu}
      >
        {/* No grip: the row is the pointer drag target; the row-covering selection button carries
            the sortable description and keeps Enter as selection. */}
        <chakra.button
          ref={setSelectRef}
          {...sortableAttributes}
          aria-current={isPrimarySelected ? 'true' : undefined}
          aria-expanded={group ? row.expanded : undefined}
          aria-label={t('widgets.layers.actions.select', { name: node.name })}
          aria-level={row.depth + 1}
          aria-selected={isSelected}
          role="treeitem"
          data-primary={isPrimarySelected || undefined}
          cursor={isDragging ? 'grabbing' : undefined}
          inset="0"
          position="absolute"
          rounded="sm"
          type="button"
          _focusVisible={ROW_SELECTION_FOCUS}
          onClick={handleSelect}
          onDoubleClick={interaction.canRename ? startEditing : undefined}
          onKeyDown={handleSelectKeyDown}
        />
        <HStack css={ROW_INTERACTIVE_DESCENDANTS} gap="1.5" pointerEvents="none" position="relative" w="full">
          {group ? (
            <>
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
              <Box
                alignItems="center"
                bg="bg.muted"
                borderColor="border.subtle"
                borderWidth="1px"
                boxSize="8"
                color="fg.muted"
                display="flex"
                flexShrink={0}
                justifyContent="center"
                rounded="sm"
              >
                <Icon as={row.expanded ? FolderOpenIcon : FolderIcon} boxSize="4" />
              </Box>
            </>
          ) : (
            <LayerThumbnail engine={engine} layer={layer!} />
          )}
          <Stack flex="1" gap="0.5" minW="0">
            {isEditing ? (
              <Input
                ref={focusOnMount}
                aria-label={t('widgets.layers.actions.rename')}
                disabled={!interaction.canRename}
                size="2xs"
                value={draftName}
                onBlur={commitName}
                onChange={handleNameChange}
                onKeyDown={handleNameKeyDown}
                onPointerDown={stopPropagation}
              />
            ) : (
              <MiddleTruncate
                aria-disabled={!interaction.canRename}
                color={row.contributionEnabled ? undefined : 'fg.muted'}
                fontSize="2xs"
                fontWeight="700"
                text={node.name}
              />
            )}
            <HStack alignSelf="flex-start" gap="1">
              {group ? (
                <Text color="fg.subtle" fontSize="2xs">
                  {row.leafCount === 0
                    ? t('widgets.layers.groupEmpty')
                    : t('widgets.layers.groupSummary', { count: row.leafCount })}
                </Text>
              ) : (
                <>
                  <Badge colorPalette="gray" size="xs" variant="subtle">
                    {t(layerBadgeKey(layer!))}
                  </Badge>
                  <ControlLayerWarningIcon contributing={row.contributionEnabled} layer={layer!} />
                </>
              )}
            </HStack>
          </Stack>
          {/* One control cluster on the same rhythm as the stack header so every row's trailing
              icons share columns; slots a row cannot use are held open. */}
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
                  color={row.documentHidden ? 'fg.subtle' : 'fg'}
                  disabled={!interaction.canToggleVisibility || hiddenByAncestor}
                  size="2xs"
                  variant="ghost"
                  onClick={handleToggleHidden}
                  onPointerDown={stopPropagation}
                >
                  {row.documentHidden ? <EyeOffIcon /> : <EyeIcon />}
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
                cursor={interaction.canToggleVisibility ? 'pointer' : 'not-allowed'}
                disabled={!interaction.canToggleVisibility}
                h="6"
                label={t('widgets.layers.actions.toggleVisibility')}
                position="relative"
                transition="none"
                w="6"
                tooltip={disabledByAncestor ? t('widgets.layers.actions.groupDisabled') : undefined}
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
                color={node.isLocked ? 'fg' : row.effectiveLocked ? 'fg.muted' : 'fg.subtle'}
                disabled={!interaction.canToggleLock || lockedByAncestor}
                size="2xs"
                variant="ghost"
                onClick={handleToggleLock}
                onPointerDown={stopPropagation}
              >
                {row.effectiveLocked ? <LockIcon /> : <LockOpenIcon />}
              </IconButton>
            </Tooltip>
            {layer ? (
              <Box
                display="flex"
                flexShrink="0"
                onClick={stopPropagation}
                onContextMenu={stopPropagation}
                onPointerDown={stopPropagation}
              >
                <LayerPropertiesPopover engine={engine} layer={layer} />
              </Box>
            ) : (
              <Box boxSize="6" />
            )}
            <Box display="flex" flexShrink="0" onPointerDown={stopPropagation}>
              {group ? (
                <LayerGroupContextMenu
                  anchor={groupMenuAnchor}
                  editingLocked={editingLocked}
                  engine={engine}
                  group={group}
                  stack={row.stack}
                  onAnchorClose={closeGroupMenu}
                />
              ) : (
                <LayerContextMenu dispatch={dispatch} engine={engine} layer={layer!} />
              )}
            </Box>
          </HStack>
        </HStack>
      </Row>
      {layer ? (
        <CanvasLayerContextMenu
          dispatch={dispatch}
          engine={engine}
          target={contextMenuTarget}
          onClose={closeContextMenu}
        />
      ) : null}
    </Box>
  );
};

export const LayerRow = memo(LayerRowComponent);
