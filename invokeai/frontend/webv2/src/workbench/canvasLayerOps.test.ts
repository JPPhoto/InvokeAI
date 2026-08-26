import type { CanvasLayerContract } from '@workbench/canvas-engine/contracts';

import { describe, expect, it } from 'vitest';

import { deleteLayerActions, duplicateLayerActions, reorderLayerActions } from './canvasLayerOps';

const layer = (id: string): CanvasLayerContract => ({
  blendMode: 'normal',
  id,
  isEnabled: true,
  isLocked: false,
  name: id,
  opacity: 1,
  source: { bitmap: null, type: 'paint' },
  transform: { rotation: 0, scaleX: 1, scaleY: 1, x: 0, y: 0 },
  type: 'raster',
});

describe('duplicateLayerActions', () => {
  it('duplicates forward and removes the duplicate on undo', () => {
    expect(duplicateLayerActions('a', 'a-copy')).toEqual({
      forward: { newId: 'a-copy', sourceId: 'a', type: 'duplicateCanvasLayer' },
      inverse: { ids: ['a-copy'], type: 'removeCanvasLayers' },
    });
  });
});

describe('deleteLayerActions', () => {
  it('removes forward and re-adds at the original index on undo', () => {
    const l = layer('a');
    expect(deleteLayerActions(l, 2)).toEqual({
      forward: { ids: ['a'], type: 'removeCanvasLayers' },
      inverse: { index: 2, layer: l, type: 'addCanvasLayer' },
    });
  });
});

describe('reorderLayerActions', () => {
  it("applies the stack commands forward and restores each stack's current order on undo", () => {
    const layers = [layer('a'), layer('b'), layer('c')];
    const command = { orderedIds: ['b', 'a', 'c'], stack: 'raster' as const };

    const stacks = [command];
    const actions = reorderLayerActions(layers, stacks);

    expect(actions).toEqual({
      forward: { stacks: [command], type: 'reorderCanvasLayerStacks' },
      inverse: { stacks: [{ orderedIds: ['a', 'b', 'c'], stack: 'raster' }], type: 'reorderCanvasLayerStacks' },
    });
    expect((actions.forward as { stacks: unknown }).stacks).not.toBe(stacks);
  });
});
