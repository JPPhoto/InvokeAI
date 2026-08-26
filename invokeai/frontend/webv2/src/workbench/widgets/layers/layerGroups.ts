import type {
  CanvasLayerContract,
  LayerStackKind,
  LayerStackMoveKind,
  ReorderFlatStackCommand,
} from '@workbench/canvas-engine/api';

import {
  getStackOrder,
  LAYER_STACKS_TOP_FIRST,
  layerStackOf,
  moveLayersWithinStacks,
} from '@workbench/canvas-engine/api';

import { moveItem } from './layersDnd';

/** Transient Layers-panel selection; only `primaryId` is persisted in the canvas document. */
export interface LayerPanelSelection {
  anchorId: string | null;
  primaryId: string | null;
  projectId: string;
  selectedIds: readonly string[];
}

export interface LayerSelectionModifiers {
  additive: boolean;
  range: boolean;
}

export const createLayerPanelSelection = (projectId: string, primaryId: string | null): LayerPanelSelection => ({
  anchorId: primaryId,
  primaryId,
  projectId,
  selectedIds: primaryId ? [primaryId] : [],
});

/** Reconciles transient selection after an external primary change, project switch, or layer removal. */
export const reconcileLayerPanelSelection = (
  selection: LayerPanelSelection,
  projectId: string,
  orderedIds: readonly string[],
  primaryId: string | null
): LayerPanelSelection => {
  const existing = new Set(orderedIds);
  const validPrimaryId = primaryId && existing.has(primaryId) ? primaryId : null;
  if (selection.projectId !== projectId || selection.primaryId !== validPrimaryId) {
    return createLayerPanelSelection(projectId, validPrimaryId);
  }
  const selected = new Set(selection.selectedIds.filter((id) => existing.has(id)));
  if (validPrimaryId) {
    selected.add(validPrimaryId);
  }
  const selectedIds = orderedIds.filter((id) => selected.has(id));
  const anchorId = selection.anchorId && existing.has(selection.anchorId) ? selection.anchorId : validPrimaryId;
  if (
    anchorId === selection.anchorId &&
    selectedIds.length === selection.selectedIds.length &&
    selectedIds.every((id, index) => id === selection.selectedIds[index])
  ) {
    return selection;
  }
  return { ...selection, anchorId, selectedIds };
};

/** Applies plain, Ctrl/Cmd-toggle, and Shift-range row selection semantics. */
export const selectLayerInPanel = (
  selection: LayerPanelSelection,
  layerId: string,
  orderedIds: readonly string[],
  modifiers: LayerSelectionModifiers
): LayerPanelSelection => {
  if (!orderedIds.includes(layerId)) {
    return selection;
  }
  if (modifiers.range) {
    const anchorId = selection.anchorId && orderedIds.includes(selection.anchorId) ? selection.anchorId : layerId;
    const start = orderedIds.indexOf(anchorId);
    const end = orderedIds.indexOf(layerId);
    const rangeIds = orderedIds.slice(Math.min(start, end), Math.max(start, end) + 1);
    const selected = modifiers.additive ? new Set(selection.selectedIds) : new Set<string>();
    rangeIds.forEach((id) => selected.add(id));
    return { ...selection, anchorId, primaryId: layerId, selectedIds: orderedIds.filter((id) => selected.has(id)) };
  }
  if (modifiers.additive) {
    const selected = new Set(selection.selectedIds);
    const wasSelected = selected.has(layerId);
    if (wasSelected) {
      selected.delete(layerId);
    } else {
      selected.add(layerId);
    }
    const selectedIds = orderedIds.filter((id) => selected.has(id));
    const primaryId = wasSelected
      ? selection.primaryId === layerId || !selection.primaryId || !selected.has(selection.primaryId)
        ? (selectedIds[0] ?? null)
        : selection.primaryId
      : layerId;
    return { ...selection, anchorId: layerId, primaryId, selectedIds };
  }
  return { ...selection, anchorId: layerId, primaryId: layerId, selectedIds: [layerId] };
};

/** A non-empty Layers panel section: one stack plus its members in flat order. */
export interface LayerGroup {
  key: LayerStackKind;
  layers: CanvasLayerContract[];
}

/**
 * Partitions layers into the non-empty type groups, in display order. Each
 * group's members keep their global relative order; empty groups are dropped.
 */
export const groupLayers = (layers: readonly CanvasLayerContract[]): LayerGroup[] =>
  LAYER_STACKS_TOP_FIRST.map((key) => ({
    key,
    layers: layers.filter((layer) => layerStackOf(layer) === key),
  })).filter((group) => group.layers.length > 0);

/** A layer's position within its own group (index 0 = top of the group). */
export interface GroupPosition {
  index: number;
  count: number;
}

/** Where `layerId` sits inside its type group, or null when it is absent. */
export const getGroupPosition = (layers: readonly CanvasLayerContract[], layerId: string): GroupPosition | null => {
  const layer = layers.find((entry) => entry.id === layerId);
  if (!layer) {
    return null;
  }
  const key = layerStackOf(layer);
  const index = layers.filter((entry) => layerStackOf(entry) === key).findIndex((entry) => entry.id === layerId);
  const count = layers.filter((entry) => layerStackOf(entry) === key).length;
  return { count, index };
};

const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * Reorders one stack: `reorderGroup` receives the stack's ids (top-to-bottom) and returns their new
 * order (or null for a no-op). Returns the stack-scoped command, or null when nothing moved.
 */
const remapGroupOrder = (
  layers: readonly CanvasLayerContract[],
  key: LayerStackKind,
  reorderGroup: (groupIds: string[]) => string[] | null
): ReorderFlatStackCommand | null => {
  const groupIds = [...getStackOrder(layers, key).orderedIds];
  const reordered = reorderGroup(groupIds);
  if (!reordered || sameOrder(reordered, groupIds)) {
    return null;
  }
  return { orderedIds: reordered, stack: key };
};

/**
 * Maps a drag-to-reorder (drop `activeId` onto same-group `overId`) to a stack command. Returns
 * null — a no-op — when the ids are equal, either is absent, they live in different stacks, or
 * nothing moved.
 */
export const reorderWithinGroup = (
  layers: readonly CanvasLayerContract[],
  activeId: string,
  overId: string
): ReorderFlatStackCommand | null => {
  if (activeId === overId) {
    return null;
  }
  const active = layers.find((layer) => layer.id === activeId);
  const over = layers.find((layer) => layer.id === overId);
  if (!active || !over || layerStackOf(active) !== layerStackOf(over)) {
    return null;
  }
  return remapGroupOrder(layers, layerStackOf(active), (groupIds) => {
    const from = groupIds.indexOf(activeId);
    const to = groupIds.indexOf(overId);
    return moveItem(groupIds, from, to);
  });
};

/**
 * Drag-reorders the selected members of the active layer's group as one block.
 * Selections in other type groups stay put. Dragging an unselected row retains
 * the normal single-row behaviour.
 */
export const reorderSelectionWithinGroup = (
  layers: readonly CanvasLayerContract[],
  activeId: string,
  overId: string,
  selectedIds: readonly string[]
): ReorderFlatStackCommand | null => {
  const active = layers.find((layer) => layer.id === activeId);
  const over = layers.find((layer) => layer.id === overId);
  if (!active || !over || layerStackOf(active) !== layerStackOf(over)) {
    return null;
  }
  const selected = new Set(selectedIds);
  if (!selected.has(activeId)) {
    return reorderWithinGroup(layers, activeId, overId);
  }
  return remapGroupOrder(layers, layerStackOf(active), (groupIds) => {
    const moving = groupIds.filter((id) => selected.has(id));
    if (moving.length < 2) {
      return moveItem(groupIds, groupIds.indexOf(activeId), groupIds.indexOf(overId));
    }
    if (selected.has(overId)) {
      return null;
    }
    const activeIndex = groupIds.indexOf(activeId);
    const overIndex = groupIds.indexOf(overId);
    const remaining = groupIds.filter((id) => !selected.has(id));
    const remainingOverIndex = remaining.indexOf(overId);
    const insertAt = activeIndex < overIndex ? remainingOverIndex + 1 : remainingOverIndex;
    return [...remaining.slice(0, insertAt), ...moving, ...remaining.slice(insertAt)];
  });
};

/** Moves `layerId` within its own stack; null when it is absent or already at the boundary. */
export const reorderWithinGroupByKind = (
  layers: readonly CanvasLayerContract[],
  layerId: string,
  kind: LayerStackMoveKind
): ReorderFlatStackCommand | null => moveLayersWithinStacks(layers, [layerId], kind)[0] ?? null;
