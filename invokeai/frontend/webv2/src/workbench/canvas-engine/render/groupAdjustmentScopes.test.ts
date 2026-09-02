import type { CanvasAdjustmentsContract } from '@workbench/canvas-engine/contracts';

import {
  documentFrom,
  groupContract,
  layerContract,
} from '@workbench/canvas-engine/document-model/documentFixtures.testStub';
import { describe, expect, it } from 'vitest';

import { collectAdjustedGroups, planGroupAdjustmentScopes } from './groupAdjustmentScopes';

const stack = (id: string): CanvasAdjustmentsContract => [
  { brightness: 0.2, contrast: 0, id, isEnabled: true, type: 'brightness-contrast' },
];
const identityStack: CanvasAdjustmentsContract = [
  { brightness: 0, contrast: 0, id: 'noop', isEnabled: true, type: 'brightness-contrast' },
];

describe('collectAdjustedGroups', () => {
  it('collects only raster-stack groups with contributing stacks', () => {
    const doc = documentFrom({
      control: [groupContract('og', [layerContract('c1', 'control')], { adjustments: stack('a') })],
      raster: [
        groupContract('g1', [layerContract('r1')], { adjustments: stack('b') }),
        groupContract('g2', [layerContract('r2')], { adjustments: identityStack }),
        groupContract('g3', [layerContract('r3')]),
      ],
    });
    expect([...collectAdjustedGroups(doc).keys()]).toEqual(['g1']);
  });
});

describe('planGroupAdjustmentScopes', () => {
  const adjusted = new Map<string, CanvasAdjustmentsContract>([
    ['g', stack('g')],
    ['h', stack('h')],
  ]);

  it('returns no scopes when nothing is adjusted', () => {
    expect(planGroupAdjustmentScopes([{ parentIds: [] }, { parentIds: ['x'] }], new Map())).toEqual([]);
  });

  it('covers a contiguous run and ignores non-adjusted ancestors', () => {
    const scopes = planGroupAdjustmentScopes(
      [{ parentIds: [] }, { parentIds: ['plain', 'g'] }, { parentIds: ['plain', 'g'] }, { parentIds: [] }],
      adjusted
    );
    expect(scopes).toEqual([{ adjustments: stack('g'), children: [], end: 3, id: 'g', start: 1 }]);
  });

  it('nests an inner adjusted group inside its outer scope', () => {
    const scopes = planGroupAdjustmentScopes(
      [{ parentIds: ['g'] }, { parentIds: ['g', 'h'] }, { parentIds: ['g', 'h'] }, { parentIds: ['g'] }],
      adjusted
    );
    expect(scopes).toEqual([
      {
        adjustments: stack('g'),
        children: [{ adjustments: stack('h'), children: [], end: 3, id: 'h', start: 1 }],
        end: 4,
        id: 'g',
        start: 0,
      },
    ]);
  });

  it('closes a scope that runs to the end of the list and separates sibling scopes', () => {
    const scopes = planGroupAdjustmentScopes(
      [{ parentIds: ['g'] }, { parentIds: [] }, { parentIds: ['h'] }, { parentIds: ['h'] }],
      adjusted
    );
    expect(scopes).toEqual([
      { adjustments: stack('g'), children: [], end: 1, id: 'g', start: 0 },
      { adjustments: stack('h'), children: [], end: 4, id: 'h', start: 2 },
    ]);
  });

  it('works identically on a reversed (bottom-first) list, as subtrees stay contiguous', () => {
    const items = [{ parentIds: [] }, { parentIds: ['g'] }, { parentIds: ['g', 'h'] }, { parentIds: ['g'] }];
    const scopes = planGroupAdjustmentScopes([...items].reverse(), adjusted);
    expect(scopes).toEqual([
      {
        adjustments: stack('g'),
        children: [{ adjustments: stack('h'), children: [], end: 2, id: 'h', start: 1 }],
        end: 3,
        id: 'g',
        start: 0,
      },
    ]);
  });
});
