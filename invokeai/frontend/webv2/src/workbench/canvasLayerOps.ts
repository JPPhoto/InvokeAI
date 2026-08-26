/**
 * Pure builders for the structural document edits shared by the layers panel and
 * the canvas widget's layer hotkeys: each returns the forward + inverse reducer
 * action pair for `engine.layers.commitStructural`, so the
 * inverse-construction logic lives in exactly one place.
 *
 * Zero React, zero import-time side effects.
 */

import type {
  CanvasDocumentCapability,
  CanvasLayerContract,
  FlatLayerInsertion,
  ReorderFlatStackCommand,
} from '@workbench/canvas-engine/api';

import { getStackOrder } from '@workbench/canvas-engine/api';

import type { CanvasProjectMutation } from './canvasProjectMutations';

/** A forward/inverse reducer-action pair for one reversible structural edit. */
export interface StructuralActions {
  forward: CanvasProjectMutation;
  inverse: CanvasProjectMutation;
}

/** Mints a fresh layer id (matches the engine's / layers panel's id shape). */
export const createLayerId = (): string => `layer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Duplicate a layer (forward), removing the duplicate on undo (inverse). */
export const duplicateLayerActions = (sourceId: string, newId: string): StructuralActions => ({
  forward: { newId, sourceId, type: 'duplicateCanvasLayer' },
  inverse: { ids: [newId], type: 'removeCanvasLayers' },
});

/** The engine surface that captures where deleted layers go back on undo. */
export type InsertionAnchorSource = Pick<CanvasDocumentCapability, 'captureRestoreAnchor'>;

/** Delete a layer (forward), re-adding it between its current same-stack neighbours on undo (inverse). */
export const deleteLayerActions = (
  layer: CanvasLayerContract,
  anchors: InsertionAnchorSource
): StructuralActions | null => {
  const anchor = anchors.captureRestoreAnchor(layer.id);
  return anchor
    ? {
        forward: { ids: [layer.id], type: 'removeCanvasLayers' },
        inverse: { anchor, layer, type: 'addCanvasLayer' },
      }
    : null;
};

/**
 * Delete every selected unlocked layer (forward), restoring each between its neighbours on undo
 * (inverse), top first so every anchor resolves. Null when nothing is selected, a selected layer is
 * locked, or a selected layer is missing from the engine document.
 */
export const deleteLayersActions = (
  layers: readonly CanvasLayerContract[],
  selectedIds: readonly string[],
  selectedLayerId: string | null,
  anchors: InsertionAnchorSource
): StructuralActions | null => {
  const selected = new Set(selectedIds);
  const removed = layers.filter((layer) => selected.has(layer.id));
  if (removed.length === 0 || removed.some((layer) => layer.isLocked)) {
    return null;
  }
  const add: FlatLayerInsertion[] = [];
  for (const layer of removed) {
    const anchor = anchors.captureRestoreAnchor(layer.id);
    if (!anchor) {
      return null;
    }
    add.push({ anchor, layers: [layer] });
  }
  return {
    forward: { ids: removed.map((layer) => layer.id), type: 'removeCanvasLayers' },
    inverse: { add, enabledUpdates: [], selectedLayerId, type: 'applyCanvasLayerStackMutation' },
  };
};

/** Apply the stack reorders (forward), restoring each stack's current order on undo (inverse). */
export const reorderLayerActions = (
  layers: readonly CanvasLayerContract[],
  stacks: readonly ReorderFlatStackCommand[]
): StructuralActions => ({
  forward: { stacks: [...stacks], type: 'reorderCanvasLayerStacks' },
  inverse: { stacks: stacks.map((command) => getStackOrder(layers, command.stack)), type: 'reorderCanvasLayerStacks' },
});
