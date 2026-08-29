import type { DragEndEvent, DragMoveEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core';
import type { CanvasDocumentContractV3, LayerStackKind } from '@workbench/canvas-engine/api';
import type { CanvasProjectMutation } from '@workbench/canvasProjectMutations';
import type { LayerSelectionModifiers } from '@workbench/layerPanelState';
import type { CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';
import type { LucideIcon } from 'lucide-react';
import type { Dispatch } from 'react';

import { Badge, Collapsible, HStack, Icon, Stack, Text } from '@chakra-ui/react';
import { closestCenter, DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { IconButton, toaster, Tooltip } from '@platform/ui';
import { canMergeVisibleRasters, getDocumentIndex, getDocumentLeaves } from '@workbench/canvas-engine/api';
import { useCanvasDocumentEditingLocked } from '@workbench/widgets/canvas/engineStoreHooks';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { useActiveProjectName } from '@workbench/WorkbenchContext';
import { ChevronDownIcon, EyeIcon, EyeOffIcon, FileDownIcon, FolderIcon, LayersIcon, PlusIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { LayerStackRows, LayerTreeRow } from './layerTreeRows';

import { stackAddItemId } from './addLayerMenu';
import { LAYER_TREE_INDENT_PX, LayerRow, type LayerRowEngine } from './LayerRow';
import {
  canExportRasterPsd,
  getStackActions,
  isStackAllVisible,
  planStackVisibilityToggle,
  stackVisibilityAxis,
} from './layerStackActions';
import { projectLayerDrop, type LayerDropTarget } from './layerTreeDrop';
import { getPsdExportNoticeKey } from './psdExportNotice';
import { useAddLayer } from './useAddLayer';

export type LayerStackEngine = LayerRowEngine &
  Pick<CanvasEngineHandle, 'document' | 'exports' | 'interaction' | 'layers'>;

const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 6 } } as const;
const OVERLAY_MODIFIERS = [restrictToVerticalAxis];
/** How long the pointer rests on a collapsed group before it opens to accept the drop. */
const HOVER_EXPAND_DELAY_MS = 600;

interface DragState {
  readonly activeId: string;
  /** Every selected row that travels with the drag, outermost only. */
  readonly activeIds: readonly string[];
  readonly overId: string | null;
  readonly depthOffset: number;
}

interface LayerStackSectionProps {
  dispatch: Dispatch<CanvasProjectMutation>;
  document: CanvasDocumentContractV3;
  engine: LayerStackEngine | null;
  isCollapsed: boolean;
  onExpandGroup: (groupId: string) => void;
  onSelect: (id: string, modifiers: LayerSelectionModifiers) => void;
  onToggleCollapse: (stack: LayerStackKind) => void;
  onToggleExpanded: (groupId: string) => void;
  selectedIds: readonly string[];
  selectedLayerId: string | null;
  stack: LayerStackRows;
}

/** The descendants a rendered row carries: the following rows with a greater depth. */
const subtreeIds = (rows: readonly LayerTreeRow[], id: string): string[] => {
  const start = rows.findIndex((row) => row.id === id);
  if (start < 0) {
    return [];
  }
  const ids = [id];
  for (let index = start + 1; index < rows.length && rows[index]!.depth > rows[start]!.depth; index += 1) {
    ids.push(rows[index]!.id);
  }
  return ids;
};

/**
 * One collapsible stack: a header (chevron + name + count + action cluster) and, when expanded,
 * the stack's tree rows in a self-contained `DndContext`, so a drag can never land in another
 * stack. Dropping projects the pointer onto a sortable-tree target (gap + depth) and commits one
 * `reparent`; rows that travel with the block leave the list for the duration of the drag.
 */
export const LayerStackSection = ({
  dispatch,
  document,
  engine,
  isCollapsed,
  onExpandGroup,
  onSelect,
  onToggleCollapse,
  onToggleExpanded,
  selectedIds,
  selectedLayerId,
  stack,
}: LayerStackSectionProps) => {
  const commitPrepared = usePreparedCommit(engine);
  const { t } = useTranslation();
  const editingLocked = useCanvasDocumentEditingLocked(engine);
  const sensors = useSensors(useSensor(PointerSensor, POINTER_SENSOR_OPTIONS));
  const [drag, setDrag] = useState<DragState | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { rows } = stack;

  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);
  useEffect(() => clearHoverTimer, [clearHoverTimer]);

  // Rows that travel with the drag leave the list; the active row stays as the insertion mark.
  const sortableRows = useMemo(() => {
    if (!drag) {
      return rows;
    }
    const travelling = new Set(drag.activeIds.flatMap((id) => subtreeIds(rows, id)));
    return rows.filter((row) => row.id === drag.activeId || !travelling.has(row.id));
  }, [drag, rows]);
  const sortableIds = useMemo(() => sortableRows.map((row) => row.id), [sortableRows]);

  const target = useMemo((): LayerDropTarget | null => {
    if (!drag) {
      return null;
    }
    const activeIndex = sortableRows.findIndex((row) => row.id === drag.activeId);
    let overId = drag.overId ?? drag.activeId;
    let edge: 'above' | 'below' = 'above';
    if (overId === drag.activeId) {
      const neighbour = sortableRows[activeIndex + 1] ?? sortableRows[activeIndex - 1];
      if (!neighbour) {
        return null;
      }
      overId = neighbour.id;
      edge = neighbour === sortableRows[activeIndex + 1] ? 'above' : 'below';
    } else {
      edge = sortableRows.findIndex((row) => row.id === overId) > activeIndex ? 'below' : 'above';
    }
    return projectLayerDrop({ activeIds: drag.activeIds, depthOffset: drag.depthOffset, edge, overId, rows });
  }, [drag, rows, sortableRows]);

  // Only rendered, outermost selected rows travel: a row hidden in a collapsed group or under another
  // selected row is not a separate block, so it is neither counted nor moved on its own.
  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const activeId = String(event.active.id);
      const selected = new Set(selectedIds.includes(activeId) ? selectedIds : [activeId]);
      const covered = new Set<string>();
      const activeIds: string[] = [];
      for (const row of rows) {
        if (!selected.has(row.id) || covered.has(row.id)) {
          continue;
        }
        activeIds.push(row.id);
        for (const id of subtreeIds(rows, row.id)) {
          covered.add(id);
        }
      }
      setDrag({ activeId, activeIds, depthOffset: 0, overId: null });
    },
    [rows, selectedIds]
  );

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    const depthOffset = Math.round(event.delta.x / LAYER_TREE_INDENT_PX);
    setDrag((current) => (current && current.depthOffset !== depthOffset ? { ...current, depthOffset } : current));
  }, []);

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const overId = event.over ? String(event.over.id) : null;
      setDrag((current) => (current && current.overId !== overId ? { ...current, overId } : current));
      clearHoverTimer();
      const over = overId && overId !== String(event.active.id) ? rows.find((row) => row.id === overId) : undefined;
      if (over && over.kind === 'group' && !over.expanded && over.childCount > 0) {
        hoverTimer.current = setTimeout(() => onExpandGroup(over.id), HOVER_EXPAND_DELAY_MS);
      }
    },
    [clearHoverTimer, onExpandGroup, rows]
  );

  const handleDragEnd = useCallback(
    (_event: DragEndEvent) => {
      clearHoverTimer();
      setDrag(null);
      if (editingLocked || !target) {
        return;
      }
      commitPrepared(t('widgets.layers.actions.reorder'), (model) =>
        model.prepare({ beforeId: target.beforeId, ids: target.ids, parentId: target.parentId, type: 'reparent' })
      );
    },
    [clearHoverTimer, commitPrepared, editingLocked, t, target]
  );

  const handleDragCancel = useCallback(() => {
    clearHoverTimer();
    setDrag(null);
  }, [clearHoverTimer]);

  const handleToggleCollapse = useCallback(() => onToggleCollapse(stack.stack), [onToggleCollapse, stack.stack]);

  const activeRow = drag ? rows.find((row) => row.id === drag.activeId) : undefined;
  const activeDrag = useMemo(
    () => (drag ? { indicatorDepth: target?.depth ?? null, isDragSource: true } : null),
    [drag, target?.depth]
  );

  return (
    <Stack gap="1">
      {/* `px` matches a row's own content edge (the list's `px="1"` plus each row's `p="1.5"`), so
          the header chevron and its action cluster sit in the same columns as the rows below. */}
      <HStack gap="1" px="2.5">
        <IconButton
          aria-label={t(isCollapsed ? 'widgets.layers.groupActions.expand' : 'widgets.layers.groupActions.collapse')}
          color="fg.subtle"
          size="2xs"
          variant="ghost"
          onClick={handleToggleCollapse}
        >
          <Icon
            as={ChevronDownIcon}
            boxSize="3.5"
            transform={isCollapsed ? 'rotate(-90deg)' : undefined}
            transitionDuration="fast"
            transitionProperty="transform"
          />
        </IconButton>
        <Text
          color="fg.muted"
          cursor="pointer"
          flex="1"
          fontSize="2xs"
          fontWeight="700"
          textTransform="uppercase"
          truncate
          userSelect="none"
          onClick={handleToggleCollapse}
        >
          {t(`widgets.layers.groups.${stack.stack}`)} ({stack.leafCount})
        </Text>
        <StackActions document={document} editingLocked={editingLocked} engine={engine} stack={stack.stack} />
      </HStack>
      {/* unmountOnExit: collapsing must UNMOUNT the rows so an open per-row properties popover — and
          any control-layer filter preview it hosts — is torn down with them. */}
      <Collapsible.Root lazyMount open={!isCollapsed} unmountOnExit>
        <Collapsible.Content>
          <DndContext
            collisionDetection={closestCenter}
            sensors={sensors}
            onDragCancel={handleDragCancel}
            onDragEnd={handleDragEnd}
            onDragMove={handleDragMove}
            onDragOver={handleDragOver}
            onDragStart={handleDragStart}
          >
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
              <Stack aria-label={t(`widgets.layers.groups.${stack.stack}`)} gap="0.5" px="1" role="tree">
                {sortableRows.map((row) => (
                  <LayerRow
                    key={row.id}
                    dispatch={dispatch}
                    drag={row.id === drag?.activeId ? activeDrag : null}
                    editingLocked={editingLocked}
                    engine={engine}
                    isPrimarySelected={row.id === selectedLayerId}
                    isSelected={selectedIds.includes(row.id)}
                    row={row}
                    onSelect={onSelect}
                    onToggleExpanded={onToggleExpanded}
                  />
                ))}
              </Stack>
            </SortableContext>
            <DragOverlay dropAnimation={null} modifiers={OVERLAY_MODIFIERS}>
              {activeRow && drag ? <LayerDragGhost count={drag.activeIds.length} row={activeRow} /> : null}
            </DragOverlay>
          </DndContext>
        </Collapsible.Content>
      </Collapsible.Root>
    </Stack>
  );
};

/** The compact card that follows the pointer: the grabbed row's name plus how many rows travel. */
const LayerDragGhost = ({ count, row }: { count: number; row: LayerTreeRow }) => (
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
    {row.kind === 'group' ? <Icon as={FolderIcon} boxSize="3.5" color="fg.muted" flexShrink={0} /> : null}
    <Text flex="1" fontSize="2xs" fontWeight="700" truncate>
      {row.node.name}
    </Text>
    {count > 1 ? (
      <Badge colorPalette="accent" size="xs" variant="solid">
        {count}
      </Badge>
    ) : null}
  </HStack>
);

/** The right-aligned stack-header action cluster; the set of actions is data (`getStackActions`). */
const StackActions = ({
  document,
  editingLocked,
  engine,
  stack,
}: {
  document: CanvasDocumentContractV3;
  editingLocked: boolean;
  engine: LayerStackEngine | null;
  stack: LayerStackKind;
}) => {
  const commitPrepared = usePreparedCommit(engine);
  const { t } = useTranslation();
  const addLayer = useAddLayer();
  const projectName = useActiveProjectName();
  const axis = stackVisibilityAxis(stack);
  const entries = getDocumentIndex(document).nodes.filter((entry) => entry.stack === stack);
  const allVisible = isStackAllVisible(entries, axis);
  // Enablement and execution share the same contributor selector and the engine's live-content
  // predicate, so empty paint layers do not enable an op.
  const canMerge =
    !editingLocked &&
    !!engine &&
    stack === 'raster' &&
    canMergeVisibleRasters(engine.document.model()?.compileLeaves() ?? [], engine.exports.hasExportableLayerContent);
  const canExport = !!engine && stack === 'raster' && canExportRasterPsd(getDocumentLeaves(document));

  const handleNew = useCallback(() => addLayer(stackAddItemId(stack)), [addLayer, stack]);

  const handleToggleVisibility = useCallback(() => {
    const { ids, nextVisible } = planStackVisibilityToggle(entries, axis);
    if (ids.length === 0) {
      return;
    }
    if (axis === 'hidden') {
      commitPrepared(t('widgets.layers.groupActions.toggleHidden'), (model) =>
        model.prepare({ type: 'set-hidden', updates: ids.map((id) => ({ id, isHidden: !nextVisible })) })
      );
      return;
    }
    commitPrepared(t('widgets.layers.groupActions.toggleVisibility'), (model) =>
      model.prepare({ type: 'set-enabled', updates: ids.map((id) => ({ id, isEnabled: nextVisible })) })
    );
  }, [axis, commitPrepared, entries, t]);

  const handleMergeVisible = useCallback(() => {
    if (!engine) {
      return;
    }
    void engine.layers.mergeVisibleRasterLayers().then((result) => {
      if (result === 'not-ready') {
        toaster.create({ title: t('widgets.layers.groupActions.mergeNotReady'), type: 'warning' });
      } else if (result === 'over-budget') {
        toaster.create({ title: t('widgets.layers.groupActions.mergeOverBudget'), type: 'warning' });
      }
    });
  }, [engine, t]);

  const handleExportPsd = useCallback(async () => {
    if (!engine) {
      return;
    }
    try {
      const result = await engine.exports.exportRasterLayersToPsd(projectName);
      const noticeKey = getPsdExportNoticeKey(result);
      if (noticeKey) {
        toaster.create({ title: t(noticeKey), type: 'warning' });
      }
    } catch {
      toaster.create({ title: t('widgets.layers.groupActions.exportFailed'), type: 'error' });
    }
  }, [engine, projectName, t]);

  return (
    <HStack gap="0.5">
      {getStackActions(stack).map((action) => {
        switch (action) {
          case 'mergeVisible':
            return (
              <StackActionButton
                key={action}
                disabled={!canMerge}
                icon={LayersIcon}
                label={t('widgets.layers.groupActions.mergeVisible')}
                onClick={handleMergeVisible}
              />
            );
          case 'exportPsd':
            return (
              <StackActionButton
                key={action}
                disabled={editingLocked || !canExport}
                icon={FileDownIcon}
                label={t('widgets.layers.groupActions.exportPsd')}
                onClick={handleExportPsd}
              />
            );
          case 'toggleVisibility':
            return (
              <StackActionButton
                key={action}
                disabled={editingLocked}
                icon={allVisible ? EyeIcon : EyeOffIcon}
                label={t(allVisible ? 'widgets.layers.groupActions.hideAll' : 'widgets.layers.groupActions.showAll')}
                onClick={handleToggleVisibility}
              />
            );
          case 'new':
            return (
              <StackActionButton
                key={action}
                disabled={editingLocked}
                icon={PlusIcon}
                label={t('widgets.layers.groupActions.new')}
                onClick={handleNew}
              />
            );
        }
      })}
    </HStack>
  );
};

const StackActionButton = ({
  disabled,
  icon,
  label,
  onClick,
}: {
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) => (
  <Tooltip content={label}>
    <IconButton aria-label={label} color="fg.subtle" disabled={disabled} size="2xs" variant="ghost" onClick={onClick}>
      <Icon as={icon} boxSize="3.5" />
    </IconButton>
  </Tooltip>
);
