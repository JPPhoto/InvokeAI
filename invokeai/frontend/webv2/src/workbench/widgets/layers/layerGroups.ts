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
