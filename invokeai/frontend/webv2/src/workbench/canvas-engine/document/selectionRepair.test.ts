import type { CanvasLayerContract } from '@workbench/canvas-engine/contracts';

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
