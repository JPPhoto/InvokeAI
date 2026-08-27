import type { CanvasLayerContract } from '@workbench/canvas-engine/contracts';

import { describe, expect, it } from 'vitest';

import type { CanvasScreenViewState } from './screenComposition';

import { planScreenComposition } from './screenComposition';
import { compileSemanticLeaf } from './semanticLeaf';

const leaf = (id: string, type: CanvasLayerContract['type'], overrides: Partial<CanvasLayerContract> = {}) =>
  compileSemanticLeaf({
    id,
    isEnabled: true,
    isLocked: false,
    transform: { rotation: 0, scaleX: 1, scaleY: 1, x: 0, y: 0 },
    type,
    ...overrides,
  } as CanvasLayerContract);

const view = (overrides: Partial<CanvasScreenViewState> = {}): CanvasScreenViewState => ({
  isolationLayerId: null,
  showOverlayStacks: { control: true, inpaint_mask: true, regional_guidance: true },
  ...overrides,
});

const leaves = [
  leaf('i1', 'inpaint_mask'),
  leaf('r1', 'raster'),
  leaf('c1', 'control', { isHidden: true } as Partial<CanvasLayerContract>),
  leaf('r2', 'raster', { isEnabled: false }),
  leaf('g1', 'regional_guidance'),
  leaf('r3', 'raster'),
];

const drawn = (plan: ReturnType<typeof planScreenComposition>): string[] => plan.leaves.map((leaf) => leaf.id);

describe('planScreenComposition', () => {
  it('draws contributing, unhidden leaves stack by stack, bottom first', () => {
    expect(drawn(planScreenComposition(leaves, view()))).toEqual(['r3', 'r1', 'g1', 'i1']);
  });

  it('applies overlay stack switches without touching raster leaves', () => {
    const plan = planScreenComposition(
      leaves,
      view({ showOverlayStacks: { control: true, inpaint_mask: false, regional_guidance: false } })
    );
    expect(drawn(plan)).toEqual(['r3', 'r1']);
  });

  it('isolates one drawable leaf regardless of the stack switches', () => {
    const plan = planScreenComposition(
      leaves,
      view({
        isolationLayerId: 'g1',
        showOverlayStacks: { control: false, inpaint_mask: false, regional_guidance: false },
      })
    );
    expect(plan).toEqual({ isolationLayerId: 'g1', leaves: [leaves[4]] });
    expect(drawn(planScreenComposition(leaves, view({ isolationLayerId: 'r1' })))).toEqual(['r1']);
  });

  it('lets isolation override document visibility while an absent target draws nothing', () => {
    expect(drawn(planScreenComposition(leaves, view({ isolationLayerId: 'c1' })))).toEqual(['c1']);
    expect(drawn(planScreenComposition(leaves, view({ isolationLayerId: 'r2' })))).toEqual(['r2']);
    expect(planScreenComposition(leaves, view({ isolationLayerId: 'ghost' })).leaves).toEqual([]);
  });
});
