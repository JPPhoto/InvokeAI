import type { CollisionDetection, DragEndEvent, DragMoveEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core';
import type { CanvasDocumentContractV3, DocumentCommand, LayerStackKind } from '@workbench/canvas-engine/api';
import type { CanvasProjectMutation } from '@workbench/canvasProjectMutations';
import type { LayerPanelState, LayerSelectionModifiers } from '@workbench/layerPanelState';
import type { CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';
import type { Dispatch, FocusEvent, KeyboardEvent, ReactNode } from 'react';

import { Box, Text } from '@chakra-ui/react';
import { DndContext, DragOverlay, pointerWithin, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { useMountEffect } from '@platform/react/useMountEffect';
import { usePreservedScrollOffset } from '@platform/react/usePreservedScrollOffset';
import { getDocumentIndex, getDocumentNode, lookupDocumentNodeState } from '@workbench/canvas-engine/api';
import {
  publishLayerPanelSelection,
  selectLayerInPanel,
  setLayerGroupExpanded,
  setLayerPanelFocus,
  toggleLayerStackCollapsed,
} from '@workbench/layerPanelState';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { useCallback, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { defaultRangeExtractor, useVirtualizer, type Range } from 'react-hook-tanstack-virtual';
import { useTranslation } from 'react-i18next';

import type { LayerRowCommands, LayerSurfaceAnchor } from './layerRowCommands';
import type { LayerStackRowsByKind } from './layerTreeRows';
import type { LayerStackActionsEngine } from './useLayerStackActions';

import {
  flattenPanelRows,
  isHeaderKey,
  isTreeNavigationKey,
  LAYER_HEADER_HEIGHT_PX,
  LAYER_TREE_INDENT_PX,
  navigateTree,
  panelRowHeight,
  stackOfHeaderKey,
  type PanelRow,
} from './layerPanelRows';
import { clearLayerPropertiesRequest, useCurrentLayerPropertiesRequest } from './layerPropertiesRequestStore';
import { LayerDragGhost, LayerRow, type LayerRowDragState } from './LayerRow';
import { anchorFromRect } from './layerRowCommands';
import { LayerStackHeader } from './LayerStackHeader';
import { LayerSurfaceHost, type LayerSurfaceEngine, type LayerSurfaceRequest } from './LayerSurfaceHost';
import { createLayerTreeAutoScroller, type LayerTreeAutoScroller } from './layerTreeAutoScroll';
import { outermostRowIds, projectLayerDrop, type LayerDropTarget } from './layerTreeDrop';

export type LayersTreeEngine = LayerStackActionsEngine & LayerSurfaceEngine & Pick<CanvasEngineHandle, 'previews'>;

const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 6 } } as const;
const OVERLAY_MODIFIERS = [restrictToVerticalAxis];
/** How long the pointer rests on a collapsed group before it opens to accept the drop. */
const HOVER_EXPAND_DELAY_MS = 600;
const OVERSCAN_ROWS = 6;

interface DragState {
  readonly activeId: string;
  readonly stack: LayerStackKind;
  /** The outermost selected rows that travel, in document order. */
  readonly activeIds: readonly string[];
  readonly travelling: ReadonlySet<string>;
  /** How many selected rows travel, the number the ghost shows. */
  readonly selectedCount: number;
  readonly overId: string | null;
  readonly edge: 'above' | 'below';
  readonly depthOffset: number;
}

interface LayersTreeProps {
  degraded: boolean;
  dispatch: Dispatch<CanvasProjectMutation>;
  document: CanvasDocumentContractV3;
  editingLocked: boolean;
  engine: LayersTreeEngine | null;
  /** Reveals the Properties pane's Layer section for `layerId` (selecting it). */
  onRevealProperties: (layerId: string) => void;
  panel: LayerPanelState;
  projectId: string;
  stacks: LayerStackRowsByKind;
}

/** Which half of the row under the pointer it sits in. */
const edgeOf = (rect: { top: number; height: number } | undefined, y: number): 'above' | 'below' =>
  rect && y >= rect.top + rect.height / 2 ? 'below' : 'above';

const isMenuKey = (event: KeyboardEvent<HTMLElement>): boolean =>
  event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);

/** The viewport box of a rendered item, the anchor a keyboard-opened menu uses. */
const anchorOfItem = (host: HTMLElement | null, key: string): LayerSurfaceAnchor | null => {
  const element = host?.querySelector<HTMLElement>(`[data-layer-row-id="${CSS.escape(key)}"]`);
  return element ? anchorFromRect(element.getBoundingClientRect()) : null;
};

/** One absolutely positioned slot of the virtual list; the style object is built once per offset. */
const VirtualSlot = ({ children, size, start }: { children: ReactNode; size: number; start: number }) => {
  const style = useMemo(() => ({ height: size, top: start }), [size, start]);
  return (
    <Box left="0" position="absolute" right="0" role="presentation" style={style}>
      {children}
    </Box>
  );
};

/**
 * The virtualized, keyboard-first layer tree: one scroll container, one drag context, one menu
 * host, fixed row heights, and a single roving tab stop over stack headers and rows.
 * Rows receive a view model and a command handle; every subscription and commit lives here.
 */
export const LayersTree = ({
  degraded,
  dispatch,
  document,
  editingLocked,
  engine,
  onRevealProperties,
  panel,
  projectId,
  stacks,
}: LayersTreeProps) => {
  const { t } = useTranslation();
  const commitPrepared = usePreparedCommit(engine);
  const propertiesRequest = useCurrentLayerPropertiesRequest();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  usePreservedScrollOffset(scrollRef);
  const [scrollTop, setScrollTop] = useState(0);
  const [surface, setSurface] = useState<LayerSurfaceRequest | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  useLayoutEffect(() => {
    dragRef.current = drag;
  }, [drag]);
  const pointerStart = useRef({ x: 0, y: 0 });
  const pointerY = useRef(0);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const pendingProperties = useRef<{ id: string; token: number; scrolled: boolean; opened: boolean } | null>(null);
  // Whether keyboard focus lives in the tree; read by the repair effect after the focused row is gone.
  const treeOwnsFocus = useRef(false);
  // The primary the panel itself selected last; any other primary change came from outside and is revealed.
  const panelSelectedPrimary = useRef<string | null>(null);
  const revealedPrimary = useRef<string | null>(null);
  const { selectedIds, primaryId } = panel;

  const requestedId = propertiesRequest?.layerId ?? null;
  const requestedStack = useMemo(
    () => (requestedId ? (getDocumentIndex(document).byId.get(requestedId)?.stack ?? null) : null),
    [document, requestedId]
  );
  const forceOpen = useCallback((stack: LayerStackKind) => stack === requestedStack, [requestedStack]);
  const panelRows = useMemo(
    () => flattenPanelRows(stacks, panel.collapsedStacks, forceOpen),
    [forceOpen, panel.collapsedStacks, stacks]
  );
  // Every item, header or node, by its tree key.
  const rowIndexByKey = useMemo(() => new Map(panelRows.map((row, index) => [row.key, index])), [panelRows]);
  const offsets = useMemo(() => {
    const starts = new Float64Array(panelRows.length + 1);
    panelRows.forEach((row, index) => {
      starts[index + 1] = starts[index]! + panelRowHeight(row);
    });
    return starts;
  }, [panelRows]);
  const headerIndexes = useMemo(
    () => panelRows.flatMap((row, index) => (row.kind === 'header' ? [index] : [])),
    [panelRows]
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allNodeIds = useMemo(() => Object.values(stacks).flatMap((stack) => stack.nodeIds), [stacks]);
  const visibleRowIds = useMemo(
    () => panelRows.flatMap((row) => (row.kind === 'node' ? [row.row.id] : [])),
    [panelRows]
  );
  const focusKey =
    panel.focusId && rowIndexByKey.has(panel.focusId)
      ? panel.focusId
      : primaryId && rowIndexByKey.has(primaryId)
        ? primaryId
        : (panelRows[0]?.key ?? null);
  const focusIndex = focusKey ? (rowIndexByKey.get(focusKey) ?? -1) : -1;

  // The focused item stays mounted whatever the scroll position: focus must never fall off the tree.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (focusIndex >= 0 && !indexes.includes(focusIndex)) {
        indexes.push(focusIndex);
        indexes.sort((a, b) => a - b);
      }
      return indexes;
    },
    [focusIndex]
  );
  const getScrollElement = useCallback(() => scrollRef.current, []);
  // Created once the scroll element exists; handlers reach it through the ref.
  const autoScroller = useRef<LayerTreeAutoScroller | null>(null);
  const estimateSize = useCallback((index: number) => panelRowHeight(panelRows[index]!), [panelRows]);
  const getItemKey = useCallback((index: number) => panelRows[index]?.key ?? index, [panelRows]);
  const virtualizer = useVirtualizer({
    count: panelRows.length,
    estimateSize,
    getItemKey,
    getScrollElement,
    overscan: OVERSCAN_ROWS,
    rangeExtractor,
    // A revealed row lands below the pinned header, never under it.
    scrollPaddingStart: LAYER_HEADER_HEIGHT_PX,
  });
  const virtualItems = virtualizer.virtualItems;
  // Fixed sizes change only with the row list; re-measure then, never per snapshot.
  const measureVirtualizer = useEffectEvent(() => {
    virtualizer.measure();
  });
  useLayoutEffect(() => {
    measureVirtualizer();
  }, [panelRows]);
  const virtualizerRef = useRef(virtualizer);
  useLayoutEffect(() => {
    virtualizerRef.current = virtualizer;
  });

  const handleScroll = useCallback(() => setScrollTop(scrollRef.current?.scrollTop ?? 0), []);

  // Event handlers read the latest render through this ref, so the command handle never changes identity.
  const latest = useRef({
    allNodeIds,
    commitPrepared,
    dispatch,
    document,
    editingLocked,
    panel,
    panelRows,
    projectId,
    rowIndexByKey,
    stacks,
    visibleRowIds,
  });
  useLayoutEffect(() => {
    latest.current = {
      allNodeIds,
      commitPrepared,
      dispatch,
      document,
      editingLocked,
      panel,
      panelRows,
      projectId,
      rowIndexByKey,
      stacks,
      visibleRowIds,
    };
  });
  // A keyboard move on a selected row carries the selection, exactly as a drag of it would.
  const movingIds = useCallback((key: string, stack: LayerStackKind): readonly string[] => {
    const { panel: current, stacks: forests } = latest.current;
    return current.selectedIds.includes(key)
      ? outermostRowIds(forests[stack].rows, new Set(current.selectedIds))
      : [key];
  }, []);

  const focusItem = useCallback((key: string) => {
    const { panel: current, projectId: project, rowIndexByKey: keys } = latest.current;
    setLayerPanelFocus(project, current.primaryId, key);
    const index = keys.get(key);
    if (index !== undefined) {
      virtualizerRef.current.scrollToIndex(index);
    }
    pendingFocus.current = key;
  }, []);

  const runStructural = useCallback((label: string, command: DocumentCommand) => {
    const { commitPrepared: commit } = latest.current;
    return commit(label, (model) => model.prepare(command));
  }, []);

  // One handle for every row and header; it reads the latest render through a ref so items never re-render for it.
  const commands = useMemo<LayerRowCommands>(
    () => ({
      endRename: () => setRenamingId(null),
      focus: (key) => {
        const { panel: current, projectId: project } = latest.current;
        if (current.focusId !== key) {
          setLayerPanelFocus(project, current.primaryId, key);
        }
      },
      keyDown: (key, event: KeyboardEvent<HTMLElement>) => {
        const { document: currentDocument, panel: current, panelRows: rows, projectId: project } = latest.current;
        if (isMenuKey(event)) {
          event.preventDefault();
          const anchor = anchorOfItem(scrollRef.current, key);
          if (anchor) {
            setSurface(
              isHeaderKey(key)
                ? { anchor, kind: 'stack-menu', stack: stackOfHeaderKey(key) }
                : { anchor, id: key, kind: 'menu' }
            );
          }
          return;
        }
        if (isHeaderKey(key)) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleLayerStackCollapsed(project, current.primaryId, stackOfHeaderKey(key));
            return;
          }
        } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          event.preventDefault();
          const vm = lookupDocumentNodeState(currentDocument, key);
          if (!vm) {
            return;
          }
          runStructural(t('widgets.layers.actions.reorder'), {
            ids: movingIds(key, vm.stack),
            kind: event.key === 'ArrowUp' ? 'forward' : 'backward',
            type: 'move',
          });
          return;
        } else if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
          event.preventDefault();
          const vm = lookupDocumentNodeState(currentDocument, key);
          if (!vm) {
            return;
          }
          // Only siblings of the focused row can follow it into or out of a group.
          const ids = movingIds(key, vm.stack).filter(
            (id) => lookupDocumentNodeState(currentDocument, id)?.parentId === vm.parentId
          );
          if (ids.length === 0) {
            return;
          }
          if (event.key === 'ArrowLeft') {
            if (vm.parentId === null) {
              return;
            }
            const parent = lookupDocumentNodeState(currentDocument, vm.parentId)!;
            const grandSiblings =
              parent.parentId === null
                ? currentDocument.stacks[parent.stack]
                : (getDocumentNode(currentDocument, parent.parentId) as { children: readonly { id: string }[] })
                    .children;
            const beforeId = grandSiblings[parent.siblingIndex + 1]?.id ?? null;
            runStructural(t('widgets.layers.actions.outdent'), {
              beforeId,
              ids,
              parentId: parent.parentId,
              type: 'reparent',
            });
            return;
          }
          const siblings =
            vm.parentId === null
              ? currentDocument.stacks[vm.stack]
              : (getDocumentNode(currentDocument, vm.parentId) as { children: readonly { id: string; type: string }[] })
                  .children;
          const above = siblings[vm.siblingIndex - 1];
          if (!above || above.type !== 'group') {
            return;
          }
          const outcome = runStructural(t('widgets.layers.actions.indent'), {
            beforeId: null,
            ids,
            parentId: above.id,
            type: 'reparent',
          });
          if (outcome.status === 'committed') {
            setLayerGroupExpanded(project, current.primaryId, [above.id], true);
          }
          return;
        } else if (event.key === 'F2') {
          event.preventDefault();
          if (!latest.current.editingLocked) {
            setRenamingId(key);
          }
          return;
        }
        if (!isTreeNavigationKey(event.key)) {
          return;
        }
        const navigation = navigateTree(rows, key, event.key);
        if (!navigation) {
          return;
        }
        event.preventDefault();
        if ('expand' in navigation) {
          setLayerGroupExpanded(project, current.primaryId, [navigation.expand], navigation.expanded);
          return;
        }
        if ('collapseStack' in navigation) {
          if (current.collapsedStacks.includes(navigation.collapseStack) !== navigation.collapsed) {
            toggleLayerStackCollapsed(project, current.primaryId, navigation.collapseStack);
          }
          return;
        }
        focusItem(navigation.focus);
      },
      openMenu: (id, anchor: LayerSurfaceAnchor) => setSurface({ anchor, id, kind: 'menu' }),
      openProperties: (id) => onRevealProperties(id),
      openStackMenu: (stack, anchor: LayerSurfaceAnchor) => setSurface({ anchor, kind: 'stack-menu', stack }),
      rename: (id, name) => runStructural(t('widgets.layers.actions.rename'), { id, patch: { name }, type: 'patch' }),
      select: (id, modifiers: LayerSelectionModifiers) => {
        const {
          allNodeIds: all,
          dispatch: send,
          panel: current,
          projectId: project,
          visibleRowIds: visible,
        } = latest.current;
        const next = selectLayerInPanel(current, id, modifiers.range ? visible : all, modifiers);
        publishLayerPanelSelection(next);
        setLayerPanelFocus(project, next.primaryId, id);
        panelSelectedPrimary.current = next.primaryId;
        if (next.primaryId !== current.primaryId) {
          send({ id: next.primaryId, type: 'setCanvasSelectedLayer' });
        }
      },
      setEnabled: (id, isEnabled) =>
        runStructural(t('widgets.layers.actions.toggleVisibility'), {
          type: 'set-enabled',
          updates: [{ id, isEnabled }],
        }),
      setHidden: (id, isHidden) =>
        runStructural(t('widgets.layers.actions.toggleHidden'), { type: 'set-hidden', updates: [{ id, isHidden }] }),
      setLocked: (id, isLocked) =>
        runStructural(t('widgets.layers.actions.toggleLock'), { type: 'set-locked', updates: [{ id, isLocked }] }),
      startRename: (id) => setRenamingId(id),
      toggleCollapse: (stack) => {
        const { panel: current, projectId: project } = latest.current;
        toggleLayerStackCollapsed(project, current.primaryId, stack);
      },
      toggleExpanded: (id) => {
        const { panel: current, projectId: project } = latest.current;
        // A filter decides expansion itself; the chevron is inert until it is cleared.
        if (current.filter.trim() === '') {
          setLayerGroupExpanded(project, current.primaryId, [id]);
        }
      },
    }),
    [onRevealProperties, focusItem, movingIds, runStructural, t]
  );

  const closeSurface = useCallback(() => {
    setSurface(null);
    if (pendingProperties.current) {
      clearLayerPropertiesRequest(pendingProperties.current.token);
      pendingProperties.current = null;
    }
  }, []);

  // A primary that changed outside the panel (canvas, undo, a new layer) is scrolled into view once,
  // as soon as it has a row; later list changes leave the scroll position alone.
  useLayoutEffect(() => {
    if (!primaryId || revealedPrimary.current === primaryId) {
      return;
    }
    if (panelSelectedPrimary.current === primaryId) {
      panelSelectedPrimary.current = null;
      revealedPrimary.current = primaryId;
      return;
    }
    const index = rowIndexByKey.get(primaryId);
    if (index !== undefined) {
      revealedPrimary.current = primaryId;
      virtualizerRef.current.scrollToIndex(index);
    }
  }, [primaryId, rowIndexByKey]);

  // A properties request from elsewhere (a menu, a hotkey) reveals its row, scrolls to it once it is
  // rendered, and then opens the surface on it exactly once; a request for a node that is gone is dropped.
  useLayoutEffect(() => {
    if (!propertiesRequest) {
      pendingProperties.current = null;
      return;
    }
    if (!getDocumentNode(document, propertiesRequest.layerId)) {
      clearLayerPropertiesRequest(propertiesRequest.token);
      pendingProperties.current = null;
      return;
    }
    let pending = pendingProperties.current;
    if (pending?.token !== propertiesRequest.token) {
      pending = { id: propertiesRequest.layerId, opened: false, scrolled: false, token: propertiesRequest.token };
      pendingProperties.current = pending;
      const vm = lookupDocumentNodeState(document, propertiesRequest.layerId);
      if (vm && vm.parentIds.length > 0) {
        setLayerGroupExpanded(projectId, primaryId, [...vm.parentIds], true);
      }
    }
    const index = rowIndexByKey.get(pending.id);
    if (!pending.scrolled && index !== undefined) {
      pendingProperties.current = { ...pending, scrolled: true };
      virtualizerRef.current.scrollToIndex(index);
    }
  }, [document, primaryId, projectId, propertiesRequest, rowIndexByKey]);

  // After paint: land a pending focus, and open a pending properties surface on its now-rendered row.
  useLayoutEffect(() => {
    const host = scrollRef.current;
    if (!host) {
      return;
    }
    if (pendingFocus.current) {
      const target = host.querySelector<HTMLElement>(`[data-layer-row-id="${CSS.escape(pendingFocus.current)}"]`);
      if (target) {
        target.focus();
        pendingFocus.current = null;
      }
    }
    const pending = pendingProperties.current;
    if (pending && pending.scrolled && !pending.opened) {
      const row = host.querySelector<HTMLElement>(`[data-layer-row-id="${CSS.escape(pending.id)}"]`);
      if (row) {
        // The row is on screen: reveal the Properties pane's Layer section and
        // settle the request — there is no popover to keep open any more.
        pendingProperties.current = null;
        onRevealProperties(pending.id);
        clearLayerPropertiesRequest(pending.token);
      }
    }
  }, [onRevealProperties, panelRows, virtualItems]);

  // Focus repair: the browser drops focus to the body when a focused row unmounts, so the tree
  // remembers whether it owned focus and puts it back on the item that now holds the tab stop.
  const handleFocusCapture = useCallback(() => {
    treeOwnsFocus.current = true;
  }, []);
  const handleBlurCapture = useCallback((event: FocusEvent<HTMLElement>) => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) {
      treeOwnsFocus.current = false;
    }
  }, []);
  useLayoutEffect(() => {
    const host = scrollRef.current;
    if (!host || !focusKey || !treeOwnsFocus.current || renamingId !== null) {
      return;
    }
    if (host.contains(window.document.activeElement) && window.document.activeElement !== window.document.body) {
      return;
    }
    host.querySelector<HTMLElement>(`[data-layer-row-id="${CSS.escape(focusKey)}"]`)?.focus();
  }, [focusKey, panelRows, renamingId, virtualItems]);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);
  useMountEffect(() => {
    autoScroller.current = createLayerTreeAutoScroller(scrollRef);
    return () => {
      clearHoverTimer();
      autoScroller.current?.stop();
    };
  });

  const sensors = useSensors(useSensor(PointerSensor, POINTER_SENSOR_OPTIONS));
  const dragDisabled = editingLocked || degraded || panel.filter.trim() !== '';
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const current = dragRef.current;
    const stack = args.active.data.current?.stack as LayerStackKind | undefined;
    // Only a row of the same stack under the pointer counts: nothing snaps across stacks or gaps.
    return pointerWithin({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (container) =>
          container.data.current?.stack === stack && !(current?.travelling.has(String(container.id)) ?? false)
      ),
    });
  }, []);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const activeId = String(event.active.id);
      const stack = event.active.data.current?.stack as LayerStackKind;
      const rows = stacks[stack].rows;
      const selected = new Set(selectedSet.has(activeId) ? selectedIds : [activeId]);
      const activeIds = outermostRowIds(rows, selected);
      const travelling = new Set<string>();
      const active = new Set(activeIds);
      let covering: number | null = null;
      for (const row of rows) {
        if (covering !== null && row.vm.depth > covering) {
          travelling.add(row.id);
          continue;
        }
        covering = null;
        if (active.has(row.id)) {
          travelling.add(row.id);
          covering = row.vm.depth;
        }
      }
      const activator = event.activatorEvent as PointerEvent;
      pointerStart.current = { x: activator.clientX ?? 0, y: activator.clientY ?? 0 };
      pointerY.current = pointerStart.current.y;
      setDrag({
        activeId,
        activeIds,
        depthOffset: 0,
        edge: 'above',
        overId: null,
        selectedCount: [...travelling].filter((id) => selected.has(id)).length,
        stack,
        travelling,
      });
    },
    [selectedIds, selectedSet, stacks]
  );
  const handleDragMove = useCallback((event: DragMoveEvent) => {
    const depthOffset = Math.round(event.delta.x / LAYER_TREE_INDENT_PX);
    pointerY.current = pointerStart.current.y + event.delta.y;
    autoScroller.current?.update(pointerY.current);
    const edge = edgeOf(event.over?.rect, pointerY.current);
    setDrag((current) =>
      current && (current.depthOffset !== depthOffset || current.edge !== edge)
        ? { ...current, depthOffset, edge }
        : current
    );
  }, []);
  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const overId = event.over ? String(event.over.id) : null;
      // The pointer may enter a row between move events; the edge follows the row it is over now.
      const edge = edgeOf(event.over?.rect, pointerY.current);
      setDrag((current) =>
        current && (current.overId !== overId || current.edge !== edge) ? { ...current, edge, overId } : current
      );
      clearHoverTimer();
      const current = dragRef.current;
      const over =
        overId && current && overId !== current.activeId
          ? stacks[current.stack].rows.find((row) => row.id === overId)
          : undefined;
      if (over && over.vm.kind === 'group' && !over.expanded && over.vm.childCount > 0) {
        hoverTimer.current = setTimeout(
          () => setLayerGroupExpanded(projectId, primaryId, [over.id], true),
          HOVER_EXPAND_DELAY_MS
        );
      }
    },
    [clearHoverTimer, primaryId, projectId, stacks]
  );

  const target = useMemo((): LayerDropTarget | null => {
    if (!drag || !drag.overId) {
      return null;
    }
    return projectLayerDrop({
      activeIds: drag.activeIds,
      depthOffset: drag.depthOffset,
      edge: drag.edge,
      overId: drag.overId,
      rows: stacks[drag.stack].rows,
    });
  }, [drag, stacks]);
  // The model is the authority on where the block may land; the indicator shows its answer before the drop.
  const refusal = useMemo(
    () =>
      target && engine
        ? (engine.document
            .model()
            ?.refusalFor({ beforeId: target.beforeId, ids: target.ids, parentId: target.parentId, type: 'reparent' }) ??
          null)
        : null,
    [engine, target]
  );

  const finishDrag = useCallback(() => {
    clearHoverTimer();
    autoScroller.current?.stop();
    setDrag(null);
  }, [clearHoverTimer]);
  const handleDragEnd = useCallback(
    (_event: DragEndEvent) => {
      const landing = target;
      const refused = refusal;
      finishDrag();
      if (!landing || refused || dragDisabled) {
        return;
      }
      commitPrepared(t('widgets.layers.actions.reorder'), (model) =>
        model.prepare({ beforeId: landing.beforeId, ids: landing.ids, parentId: landing.parentId, type: 'reparent' })
      );
    },
    [commitPrepared, dragDisabled, finishDrag, refusal, t, target]
  );

  const indicator = useMemo(() => {
    if (!target || !drag) {
      return null;
    }
    const stackRows = stacks[drag.stack].rows;
    let top: number;
    if (target.beforeRowId) {
      top = offsets[rowIndexByKey.get(target.beforeRowId)!]!;
    } else {
      const last = stackRows[stackRows.length - 1]!;
      top = offsets[rowIndexByKey.get(last.id)! + 1]!;
    }
    return { left: target.depth * LAYER_TREE_INDENT_PX + 8, top };
  }, [drag, offsets, rowIndexByKey, stacks, target]);

  const refusalReason = refusal
    ? t(
        refusal.status === 'locked'
          ? 'widgets.canvas.structural.refusedLocked'
          : refusal.status === 'invalid-target' && refusal.reason === 'cycle'
            ? 'widgets.canvas.structural.refusedCycle'
            : refusal.status === 'invalid-target' && refusal.reason === 'depth-exceeded'
              ? 'widgets.canvas.structural.refusedDepth'
              : 'widgets.canvas.structural.refusedInvalidTarget'
      )
    : null;

  // The stack whose header scrolled out keeps a pinned copy; the next header pushes it up as it arrives.
  const pinnedHeader = useMemo(() => {
    let low = 0;
    let high = headerIndexes.length - 1;
    let pinned = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (offsets[headerIndexes[middle]!]! < scrollTop) {
        pinned = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (pinned < 0) {
      return null;
    }
    const next = headerIndexes[pinned + 1];
    const nextTop = next === undefined ? Number.POSITIVE_INFINITY : offsets[next]! - scrollTop;
    return {
      row: panelRows[headerIndexes[pinned]!] as Extract<PanelRow, { kind: 'header' }>,
      shift: Math.min(0, nextTop - LAYER_HEADER_HEIGHT_PX),
    };
  }, [headerIndexes, offsets, panelRows, scrollTop]);
  const pinnedStyle = useMemo(
    () => (pinnedHeader ? { transform: `translateY(${pinnedHeader.shift}px)` } : undefined),
    [pinnedHeader]
  );

  const activeVm = drag ? lookupDocumentNodeState(document, drag.activeId) : null;
  const dragStateOf = (id: string): LayerRowDragState =>
    drag ? (id === drag.activeId ? 'source' : drag.travelling.has(id) ? 'travelling' : null) : null;

  const renderHeader = (row: Extract<PanelRow, { kind: 'header' }>, pinned: boolean) => (
    <LayerStackHeader
      collapsed={row.collapsed}
      commands={commands}
      document={document}
      editingLocked={editingLocked}
      engine={engine}
      focused={row.key === focusKey}
      leafCount={row.stack.leafCount}
      pinned={pinned}
      posInSet={row.posInSet}
      rowKey={row.key}
      setSize={row.setSize}
      stack={row.stack.stack}
    />
  );

  return (
    <DndContext
      autoScroll={false}
      collisionDetection={collisionDetection}
      sensors={sensors}
      onDragCancel={finishDrag}
      onDragEnd={handleDragEnd}
      onDragMove={handleDragMove}
      onDragOver={handleDragOver}
      onDragStart={handleDragStart}
    >
      <Box flex="1" minH="0" position="relative">
        <Box
          ref={scrollRef}
          h="full"
          overflowX="hidden"
          overflowY="auto"
          position="relative"
          onBlurCapture={handleBlurCapture}
          onFocusCapture={handleFocusCapture}
          onScroll={handleScroll}
        >
          <Box
            aria-label={t('widgets.layers.tree')}
            aria-multiselectable="true"
            h={`${virtualizer.totalSize}px`}
            position="relative"
            role="tree"
            w="full"
          >
            {virtualItems.map((item) => {
              // The window applies a changed key set one commit late; a slot draws the row its key
              // names, never the row at its index, so no node is relabelled in between.
              const rowIndex = rowIndexByKey.get(String(item.key));
              const panelRow = rowIndex === undefined ? undefined : panelRows[rowIndex];
              if (!panelRow) {
                return null;
              }
              return (
                <VirtualSlot key={item.key} size={item.size} start={item.start}>
                  {panelRow.kind === 'node' ? (
                    <LayerRow
                      commands={commands}
                      drag={dragStateOf(panelRow.row.id)}
                      dragDisabled={dragDisabled}
                      editingLocked={editingLocked}
                      engine={engine}
                      focused={panelRow.row.id === focusKey}
                      primary={panelRow.row.id === primaryId}
                      renaming={panelRow.row.id === renamingId}
                      row={panelRow.row}
                      selected={selectedSet.has(panelRow.row.id)}
                      thumbnails={!degraded}
                    />
                  ) : (
                    renderHeader(panelRow, false)
                  )}
                </VirtualSlot>
              );
            })}
            {indicator ? (
              <Box
                aria-hidden
                bg={refusal ? 'fg.error' : 'accent.solid'}
                h="2px"
                left={`${indicator.left}px`}
                pointerEvents="none"
                position="absolute"
                right="2"
                rounded="full"
                top={`${indicator.top - 1}px`}
              >
                {refusalReason ? (
                  <Text
                    bg="bg.panel"
                    color="fg.error"
                    fontSize="2xs"
                    left="0"
                    maxW="full"
                    position="absolute"
                    px="1"
                    rounded="sm"
                    top="1"
                  >
                    {t('widgets.layers.dropRefused', { reason: refusalReason })}
                  </Text>
                ) : null}
              </Box>
            ) : null}
          </Box>
        </Box>
        {pinnedHeader ? (
          <Box
            borderBottomWidth="1px"
            borderColor="border.subtle"
            h={`${LAYER_HEADER_HEIGHT_PX}px`}
            left="0"
            position="absolute"
            right="0"
            style={pinnedStyle}
            top="0"
            zIndex="1"
          >
            {renderHeader(pinnedHeader.row, true)}
          </Box>
        ) : null}
        <DragOverlay dropAnimation={null} modifiers={OVERLAY_MODIFIERS}>
          {activeVm && drag ? <LayerDragGhost count={drag.selectedCount} vm={activeVm} /> : null}
        </DragOverlay>
      </Box>
      <LayerSurfaceHost
        dispatch={dispatch}
        document={document}
        editingLocked={editingLocked}
        engine={engine}
        surface={surface}
        onClose={closeSurface}
      />
    </DndContext>
  );
};
