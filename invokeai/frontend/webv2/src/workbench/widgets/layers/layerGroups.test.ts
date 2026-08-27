import type {
  CanvasControlLayerContract,
  CanvasInpaintMaskLayerContract,
  CanvasLayerContract,
  CanvasRegionalGuidanceLayerContract,
} from '@workbench/canvas-engine/contracts';

import { describe, expect, it } from 'vitest';

import { getGroupPosition, groupLayers, reorderSelectionWithinGroup, reorderWithinGroup } from './layerGroups';
import { createEmptyPaintLayer } from './layerOps';

const raster = (id: string): CanvasLayerContract => createEmptyPaintLayer(id, id);

const base = (id: string) => ({
  blendMode: 'normal' as const,
  id,
  isEnabled: true,
  isLocked: false,
  name: id,
  opacity: 1,
  transform: { rotation: 0, scaleX: 1, scaleY: 1, x: 0, y: 0 },
});

const mask = (): { bitmap: null; fill: { color: string; style: 'solid' } } => ({
  bitmap: null,
  fill: { color: '#f00', style: 'solid' },
});

const control = (id: string): CanvasControlLayerContract => ({
  ...base(id),
  adapter: { beginEndStepPct: [0, 1], controlMode: null, kind: 'controlnet', model: null, weight: 1 },
  source: { bitmap: null, type: 'paint' },
  type: 'control',
  withTransparencyEffect: true,
});

const regional = (id: string): CanvasRegionalGuidanceLayerContract => ({
  ...base(id),
  autoNegative: false,
  mask: mask(),
  negativePrompt: null,
  positivePrompt: null,
  referenceImages: [],
  type: 'regional_guidance',
});

const inpaint = (id: string): CanvasInpaintMaskLayerContract => ({
  ...base(id),
  mask: mask(),
  type: 'inpaint_mask',
});

const ids = (layers: CanvasLayerContract[]): string[] => layers.map((layer) => layer.id);

describe('groupLayers', () => {
  it('partitions into non-empty groups in display order, preserving global order within a group', () => {
    // Global z-order (index 0 = top) with interleaved types.
    const layers = [inpaint('i1'), raster('r1'), regional('g1'), raster('r2'), control('c1'), inpaint('i2')];
    const groups = groupLayers(layers);
    expect(groups.map((group) => group.key)).toEqual(['inpaint_mask', 'regional_guidance', 'control', 'raster']);
    expect(ids(groups[0]!.layers)).toEqual(['i1', 'i2']);
    expect(ids(groups[1]!.layers)).toEqual(['g1']);
    expect(ids(groups[2]!.layers)).toEqual(['c1']);
    expect(ids(groups[3]!.layers)).toEqual(['r1', 'r2']);
  });

  it('drops empty groups', () => {
    const groups = groupLayers([raster('r1'), raster('r2')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('raster');
  });

  it('returns nothing for an empty document', () => {
    expect(groupLayers([])).toEqual([]);
  });
});

describe('getGroupPosition', () => {
  const layers = [inpaint('i1'), raster('r1'), raster('r2'), raster('r3')];

  it('reports index within the group and the group count', () => {
    expect(getGroupPosition(layers, 'r1')).toEqual({ count: 3, index: 0 });
    expect(getGroupPosition(layers, 'r3')).toEqual({ count: 3, index: 2 });
    expect(getGroupPosition(layers, 'i1')).toEqual({ count: 1, index: 0 });
  });

  it('returns null for an absent id', () => {
    expect(getGroupPosition(layers, 'ghost')).toBeNull();
  });
});

describe('reorderWithinGroup', () => {
  // Interleaved: raster r1/r2/r3 sit at global slots 1, 3, 4.
  const layers = [inpaint('i1'), raster('r1'), regional('g1'), raster('r2'), raster('r3')];

  it('moves a raster below another raster, keeping other-group layers in place', () => {
    // r1 (slot 1) dropped onto r3 (slot 4): raster subsequence r1,r2,r3 -> r2,r3,r1
    // written back into slots [1,3,4]; i1 and g1 keep slots 0 and 2.
    expect(reorderWithinGroup(layers, 'r1', 'r3')).toEqual({ orderedIds: ['r2', 'r3', 'r1'], stack: 'raster' });
  });

  it('moves a raster up', () => {
    expect(reorderWithinGroup(layers, 'r3', 'r1')).toEqual({ orderedIds: ['r3', 'r1', 'r2'], stack: 'raster' });
  });

  it('rejects a cross-group drop (raster onto regional)', () => {
    expect(reorderWithinGroup(layers, 'r1', 'g1')).toBeNull();
  });

  it('rejects a no-op (active equals over)', () => {
    expect(reorderWithinGroup(layers, 'r1', 'r1')).toBeNull();
  });

  it('rejects when an id is absent', () => {
    expect(reorderWithinGroup(layers, 'ghost', 'r1')).toBeNull();
    expect(reorderWithinGroup(layers, 'r1', 'ghost')).toBeNull();
  });
});

describe('reorderSelectionWithinGroup', () => {
  const layers = [inpaint('i1'), raster('r1'), regional('g1'), raster('r2'), raster('r3'), raster('r4')];

  it('drags selected members of the active group as one ordered block', () => {
    expect(reorderSelectionWithinGroup(layers, 'r1', 'r4', ['r1', 'r3'])).toEqual({
      orderedIds: ['r2', 'r4', 'r1', 'r3'],
      stack: 'raster',
    });
  });

  it('moves the selected block toward the front', () => {
    expect(reorderSelectionWithinGroup(layers, 'r3', 'r1', ['r2', 'r3'])).toEqual({
      orderedIds: ['r2', 'r3', 'r1', 'r4'],
      stack: 'raster',
    });
  });

  it('falls back to a single-layer drag when the active row is not selected', () => {
    expect(reorderSelectionWithinGroup(layers, 'r1', 'r3', ['r2', 'r4'])).toEqual({
      orderedIds: ['r2', 'r3', 'r1', 'r4'],
      stack: 'raster',
    });
  });

  it('does not reorder when the block is dropped on one of its own members', () => {
    expect(reorderSelectionWithinGroup(layers, 'r1', 'r3', ['r1', 'r3'])).toBeNull();
  });
});
