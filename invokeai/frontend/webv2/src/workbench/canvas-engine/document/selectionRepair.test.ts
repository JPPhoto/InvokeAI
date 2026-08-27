import type { CanvasLayerContract } from '@workbench/canvas-engine/contracts';

import { flatDocument, layerContract } from '@workbench/canvas-engine/document-model/documentFixtures.testStub';
import { applyCanvasProjectMutation, type CanvasProjectMutation } from '@workbench/canvasProjectMutations';
import { createInitialWorkbenchState } from '@workbench/workbenchState';
import { describe, expect, it } from 'vitest';

import { repairSelectedLayerId } from './selectionRepair';

const layer = (id: string, type: CanvasLayerContract['type'] = 'raster'): CanvasLayerContract =>
  ({ id, type }) as CanvasLayerContract;
const previous = ['a', 'b', 'c', 'd'].map((id) => layer(id));
const without = (...ids: string[]) => previous.filter((entry) => !ids.includes(entry.id));

describe('repairSelectedLayerId', () => {
  it.each([
    ['keeps a surviving selection', without('a'), 'b', previous, 'b'],
    ['keeps null', previous, null, previous, null],
    ['moves below first', without('b'), 'b', previous, 'c'],
    ['moves above when nothing survives below', without('c', 'd'), 'd', previous, 'b'],
    ['moves through a removed run', without('b', 'c'), 'b', previous, 'd'],
    ['falls back to the top without a previous order', without('b'), 'b', undefined, 'a'],
    ['falls back to the top when the selection was never present', without('b'), 'x', previous, 'a'],
    ['clears on an empty document', [], 'b', previous, null],
    ['clears on an empty document without a previous order', [], 'b', undefined, null],
  ])('%s', (_label, layers, selected, previousLayers, expected) => {
    expect(repairSelectedLayerId(layers, selected, previousLayers)).toBe(expected);
  });

  it('prefers a neighbour in the same stack over a closer one in another stack', () => {
    const mixed = [layer('i1', 'inpaint_mask'), layer('r1'), layer('c1', 'control'), layer('r2')];
    const withoutR1 = mixed.filter((entry) => entry.id !== 'r1');

    expect(repairSelectedLayerId(withoutR1, 'r1', mixed)).toBe('r2');
    expect(repairSelectedLayerId([mixed[0]!, mixed[2]!], 'r1', mixed)).toBe('c1');
  });
});

describe('selection repair through the reducer', () => {
  const layers = () => [
    layerContract('i1', 'inpaint_mask'),
    layerContract('r1'),
    layerContract('c1', 'control'),
    layerContract('r2'),
    layerContract('r3'),
  ];
  const reduce = (selectedLayerId: string | null, mutation: CanvasProjectMutation, initialLayers = layers()) => {
    const project = applyCanvasProjectMutation(createInitialWorkbenchState().projects[0]!, {
      document: flatDocument(initialLayers, selectedLayerId),
      type: 'replaceCanvasDocument',
    });
    return applyCanvasProjectMutation(project, mutation).canvas.document.selectedLayerId;
  };
  const paint = { bitmap: null, type: 'paint' as const };

  it.each<[string, string | null, CanvasProjectMutation, string | null]>([
    ['remove keeps a surviving selection', 'r2', { ids: ['r1'], type: 'removeCanvasLayers' }, 'r2'],
    ['remove moves to the same-stack neighbour below', 'r1', { ids: ['r1'], type: 'removeCanvasLayers' }, 'r2'],
    [
      'remove moves above within the stack when nothing survives below',
      'r3',
      { ids: ['r3'], type: 'removeCanvasLayers' },
      'r2',
    ],
    ['remove falls back across stacks when the stack empties', 'c1', { ids: ['c1'], type: 'removeCanvasLayers' }, 'r2'],
    ['duplicate selects the copy', 'r1', { newId: 'r1-copy', sourceId: 'r1', type: 'duplicateCanvasLayer' }, 'r1-copy'],
    [
      'merge down moves the selection onto the merged layer',
      'r2',
      { source: paint, type: 'mergeCanvasLayersDown', upperLayerId: 'r2' },
      'r3',
    ],
    [
      'merge down keeps a selection elsewhere',
      'i1',
      { source: paint, type: 'mergeCanvasLayersDown', upperLayerId: 'r2' },
      'i1',
    ],
    [
      'replacement keeps a selection the new document holds',
      'r1',
      { document: flatDocument([layerContract('r1')], 'r1'), type: 'replaceCanvasDocument' },
      'r1',
    ],
    [
      'replacement selects the top when its selection is absent',
      'r1',
      { document: flatDocument([layerContract('x'), layerContract('y')], 'nope'), type: 'replaceCanvasDocument' },
      'x',
    ],
    [
      'an emptied document clears the selection',
      'r1',
      { ids: ['i1', 'r1', 'c1', 'r2', 'r3'], type: 'removeCanvasLayers' },
      null,
    ],
    [
      'an empty replacement clears the selection',
      'r1',
      { document: flatDocument([], 'r1'), type: 'replaceCanvasDocument' },
      null,
    ],
  ])('%s', (_label, selected, mutation, expected) => {
    expect(reduce(selected, mutation)).toBe(expected);
  });
});
