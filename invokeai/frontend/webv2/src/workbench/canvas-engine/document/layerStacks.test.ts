import type { CanvasLayerContract } from '@workbench/canvas-engine/contracts';

import { describe, expect, it } from 'vitest';

import {
  getStackOrder,
  LAYER_STACK_ORDER,
  LAYER_STACKS_TOP_FIRST,
  layerStackRank,
  moveLayersWithinStacks,
  reorderLayerStack,
} from './layerStacks';

const layer = (id: string, type: CanvasLayerContract['type']): CanvasLayerContract =>
  ({ id, isEnabled: true, isLocked: false, type }) as CanvasLayerContract;

const layers = [layer('i1', 'inpaint_mask'), layer('r1', 'raster'), layer('c1', 'control'), layer('r2', 'raster')];
const ids = (entries: readonly CanvasLayerContract[] | null | undefined): string[] | undefined =>
  entries?.map((entry) => entry.id);

describe('layer stacks', () => {
  it('declares one composite order and its panel mirror', () => {
    expect(LAYER_STACK_ORDER).toEqual(['raster', 'control', 'regional_guidance', 'inpaint_mask']);
    expect(LAYER_STACKS_TOP_FIRST).toEqual([...LAYER_STACK_ORDER].reverse());
    expect(layers.map(layerStackRank)).toEqual([3, 0, 1, 0]);
  });

  it('reads a stack in flat order, empty stacks included', () => {
    expect(getStackOrder(layers, 'raster')).toEqual({ orderedIds: ['r1', 'r2'], stack: 'raster' });
    expect(getStackOrder(layers, 'regional_guidance')).toEqual({ orderedIds: [], stack: 'regional_guidance' });
  });

  it('reorders a stack inside its own slots and keeps other layers where they are', () => {
    const next = reorderLayerStack(layers, { orderedIds: ['r2', 'r1'], stack: 'raster' });

    expect(ids(next)).toEqual(['i1', 'r2', 'c1', 'r1']);
    expect(next?.[0]).toBe(layers[0]);
  });

  it('accepts an unchanged order, a single-member stack, and an empty stack', () => {
    expect(ids(reorderLayerStack(layers, { orderedIds: ['r1', 'r2'], stack: 'raster' }))).toEqual(ids(layers));
    expect(ids(reorderLayerStack(layers, { orderedIds: ['c1'], stack: 'control' }))).toEqual(ids(layers));
    expect(ids(reorderLayerStack(layers, { orderedIds: [], stack: 'regional_guidance' }))).toEqual(ids(layers));
  });

  it.each([
    ['a missing member', 'raster', ['r1']],
    ['a duplicate', 'raster', ['r1', 'r1']],
    ['a foreign id', 'raster', ['r1', 'x']],
    ['a member of another stack', 'raster', ['r1', 'c1']],
    ['members for an empty stack', 'regional_guidance', ['r1']],
  ] as const)('refuses %s', (_label, stack, orderedIds) => {
    expect(reorderLayerStack(layers, { orderedIds, stack })).toBeNull();
  });
});

describe('moveLayersWithinStacks', () => {
  const stacked = [
    layer('i1', 'inpaint_mask'),
    layer('r1', 'raster'),
    layer('g1', 'regional_guidance'),
    layer('r2', 'raster'),
    layer('i2', 'inpaint_mask'),
    layer('r3', 'raster'),
    layer('g2', 'regional_guidance'),
    layer('r4', 'raster'),
  ];

  it('moves selected layers forward one place independently in each stack, top stack first', () => {
    expect(moveLayersWithinStacks(stacked, ['i2', 'r2', 'r4', 'g2'], 'forward')).toEqual([
      { orderedIds: ['i2', 'i1'], stack: 'inpaint_mask' },
      { orderedIds: ['g2', 'g1'], stack: 'regional_guidance' },
      { orderedIds: ['r2', 'r1', 'r4', 'r3'], stack: 'raster' },
    ]);
  });

  it('moves selected layers to the back of their own stacks while preserving their order', () => {
    expect(moveLayersWithinStacks(stacked, ['i1', 'r1', 'r3', 'g1'], 'back')).toEqual([
      { orderedIds: ['i2', 'i1'], stack: 'inpaint_mask' },
      { orderedIds: ['g2', 'g1'], stack: 'regional_guidance' },
      { orderedIds: ['r2', 'r4', 'r1', 'r3'], stack: 'raster' },
    ]);
  });

  it('moves a single layer one step or to the boundary', () => {
    expect(moveLayersWithinStacks(stacked, ['r3'], 'backward')).toEqual([
      { orderedIds: ['r1', 'r2', 'r4', 'r3'], stack: 'raster' },
    ]);
    expect(moveLayersWithinStacks(stacked, ['r3'], 'front')).toEqual([
      { orderedIds: ['r3', 'r1', 'r2', 'r4'], stack: 'raster' },
    ]);
  });

  it('returns no commands when every selected layer is already at the requested boundary', () => {
    expect(moveLayersWithinStacks(stacked, ['i1', 'r1', 'g1'], 'front')).toEqual([]);
    expect(moveLayersWithinStacks(stacked, ['ghost'], 'front')).toEqual([]);
  });
});
