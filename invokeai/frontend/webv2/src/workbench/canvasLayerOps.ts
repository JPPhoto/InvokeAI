/**
 * Pure builders for the structural document edits shared by the layers panel and
 * the canvas widget's layer hotkeys: each returns the forward + inverse reducer
 * action pair for `engine.layers.commitStructural`, so the
 * inverse-construction logic lives in exactly one place.
 *
 * Index convention matches the contract and the layers panel: index 0 is the
 * top-most layer, so "up"/"forward" moves toward index 0.
 *
 * Zero React, zero import-time side effects.
 */

import type { CanvasLayerContract, ReorderFlatStackCommand } from '@workbench/canvas-engine/api';

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

/** Delete a layer (forward), re-adding it at its original index on undo (inverse). */
export const deleteLayerActions = (layer: CanvasLayerContract, index: number): StructuralActions => ({
  forward: { ids: [layer.id], type: 'removeCanvasLayers' },
  inverse: { index, layer, type: 'addCanvasLayer' },
});

/** Apply the stack reorders (forward), restoring each stack's current order on undo (inverse). */
export const reorderLayerActions = (
  layers: readonly CanvasLayerContract[],
  stacks: readonly ReorderFlatStackCommand[]
): StructuralActions => ({
  forward: { stacks: [...stacks], type: 'reorderCanvasLayerStacks' },
  inverse: { stacks: stacks.map((command) => getStackOrder(layers, command.stack)), type: 'reorderCanvasLayerStacks' },
});
