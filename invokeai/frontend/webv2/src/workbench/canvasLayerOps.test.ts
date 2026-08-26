import type { CanvasLayerContract } from '@workbench/canvas-engine/contracts';

import { captureRestoreAnchor } from '@workbench/canvas-engine/api';
import { describe, expect, it } from 'vitest';

import { deleteLayerActions, deleteLayersActions, duplicateLayerActions, reorderLayerActions } from './canvasLayerOps';

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

let current: CanvasLayerContract[] = [];
const anchors = {
  captureRestoreAnchor: (layerId: string) => captureRestoreAnchor(current, layerId, 'p', 0),
};
const restoreAnchor = (beforeId: string | null, afterId: string | null) => ({
  afterId,
  beforeId,
  capturedEditRevision: 0,
  projectId: 'p',
  stack: 'raster',
});

describe('deleteLayerActions', () => {
  it('removes forward and re-adds between the same-stack neighbours on undo', () => {
    current = [layer('a'), layer('b'), layer('c')];
    expect(deleteLayerActions(current[1]!, anchors)).toEqual({
      forward: { ids: ['b'], type: 'removeCanvasLayers' },
      inverse: {
        anchor: { afterId: 'a', beforeId: 'c', capturedEditRevision: 0, projectId: 'p', stack: 'raster' },
        layer: current[1],
        type: 'addCanvasLayer',
      },
    });
  });

  it('returns null for a layer that is not in the document', () => {
    current = [layer('a')];
    expect(deleteLayerActions(layer('ghost'), anchors)).toBeNull();
  });
});

describe('deleteLayersActions', () => {
  it('restores non-contiguous layers between their neighbours, top first, and the primary selection', () => {
    current = [layer('a'), layer('b'), layer('c'), layer('d')];
    expect(deleteLayersActions(current, ['c', 'a'], 'c', anchors)).toEqual({
      forward: { ids: ['a', 'c'], type: 'removeCanvasLayers' },
      inverse: {
        add: [
          { anchor: restoreAnchor('b', null), layers: [current[0]] },
          { anchor: restoreAnchor('d', 'b'), layers: [current[2]] },
        ],
        enabledUpdates: [],
        selectedLayerId: 'c',
        type: 'applyCanvasLayerStackMutation',
      },
    });
  });

  it('ignores absent ids and returns null when none exist', () => {
    current = [layer('a')];
    expect(deleteLayersActions(current, ['missing'], 'a', anchors)).toBeNull();
  });

  it('refuses to delete a selection containing a locked layer', () => {
    current = [layer('a'), { ...layer('b'), isLocked: true }];
    expect(deleteLayersActions(current, ['a', 'b'], 'a', anchors)).toBeNull();
  });

  it('refuses when a selected layer is missing from the engine document', () => {
    current = [layer('a')];
    expect(deleteLayersActions([layer('a'), layer('b')], ['a', 'b'], 'a', anchors)).toBeNull();
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
