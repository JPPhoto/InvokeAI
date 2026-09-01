import type { RegionalGuidanceReferenceImage } from '@workbench/canvas-engine/api';

import { documentFrom, layerContract } from '@workbench/canvas-engine/document-model/documentFixtures.testStub';
import { describe, expect, it } from 'vitest';

import type { PanelRow } from './layerPanelRows';

import { projectLayerChildRows } from './layerChildRows';
import { flattenPanelRows, navigateTree, panelRowHeight } from './layerPanelRows';
import { buildLayerStackRows } from './layerTreeRows';

const referenceImage = (id: string): RegionalGuidanceReferenceImage => ({
  config: {
    beginEndStepPct: [0, 1],
    clipVisionModel: 'ViT-H',
    image: null,
    method: 'full',
    model: null,
    type: 'ip_adapter',
    weight: 1,
  },
  id,
  isEnabled: true,
});

/** regional: rg1[ref1, ref2], rg2 · raster: r1 */
const stacks = () =>
  buildLayerStackRows(
    documentFrom([
      layerContract('rg1', 'regional_guidance', { referenceImages: [referenceImage('ref1'), referenceImage('ref2')] }),
      layerContract('rg2', 'regional_guidance'),
      layerContract('r1'),
    ]).stacks,
    new Set()
  );

const open = () => false;

const flatten = (collapsedLayerIds: ReadonlySet<string> = new Set()) =>
  flattenPanelRows(stacks(), [], open, { collapsedLayerIds, rowsFor: (row) => projectLayerChildRows(row.vm) });

const keys = (rows: readonly PanelRow[]) => rows.map((row) => row.key);

describe('flattenPanelRows with child rows', () => {
  it('inserts child rows after their layer, honoring per-layer collapse', () => {
    expect(keys(flatten())).toEqual([
      'header:regional_guidance',
      'rg1',
      'child:rg1:ref1',
      'child:rg1:ref2',
      'rg2',
      'header:raster',
      'r1',
    ]);
    expect(keys(flatten(new Set(['rg1'])))).toEqual(['header:regional_guidance', 'rg1', 'rg2', 'header:raster', 'r1']);
  });

  it('marks owning rows with their child count and expansion, and leaves others bare', () => {
    const rows = flatten();
    const rg1 = rows.find((row) => row.key === 'rg1');
    const rg2 = rows.find((row) => row.key === 'rg2');
    expect(rg1).toMatchObject({ childCount: 2, childrenExpanded: true, kind: 'node' });
    expect(rg2).toMatchObject({ childCount: 0, childrenExpanded: false });
    expect(flatten(new Set(['rg1'])).find((row) => row.key === 'rg1')).toMatchObject({
      childCount: 2,
      childrenExpanded: false,
    });
  });

  it('projects nothing without a child-rows source and sizes child rows below layer rows', () => {
    expect(keys(flattenPanelRows(stacks(), [], open))).toEqual([
      'header:regional_guidance',
      'rg1',
      'rg2',
      'header:raster',
      'r1',
    ]);
    const child = flatten().find((row) => row.kind === 'child')!;
    const node = flatten().find((row) => row.kind === 'node')!;
    expect(panelRowHeight(child)).toBeLessThan(panelRowHeight(node));
  });
});

describe('navigateTree over child rows', () => {
  it('walks child rows vertically like any other row', () => {
    const rows = flatten();
    expect(navigateTree(rows, 'rg1', 'ArrowDown')).toEqual({ focus: 'child:rg1:ref1' });
    expect(navigateTree(rows, 'child:rg1:ref2', 'ArrowDown')).toEqual({ focus: 'rg2' });
    expect(navigateTree(rows, 'rg2', 'ArrowUp')).toEqual({ focus: 'child:rg1:ref2' });
  });

  it('ArrowRight expands then enters the children; ArrowLeft collapses or climbs to the layer', () => {
    expect(navigateTree(flatten(new Set(['rg1'])), 'rg1', 'ArrowRight')).toEqual({
      expandChildren: 'rg1',
      expanded: true,
    });
    expect(navigateTree(flatten(), 'rg1', 'ArrowRight')).toEqual({ focus: 'child:rg1:ref1' });
    expect(navigateTree(flatten(), 'rg1', 'ArrowLeft')).toEqual({ expandChildren: 'rg1', expanded: false });
    expect(navigateTree(flatten(), 'child:rg1:ref2', 'ArrowLeft')).toEqual({ focus: 'rg1' });
    expect(navigateTree(flatten(), 'child:rg1:ref1', 'ArrowRight')).toBeNull();
    expect(navigateTree(flatten(), 'rg2', 'ArrowRight')).toBeNull();
    expect(navigateTree(flatten(new Set(['rg1'])), 'rg1', 'ArrowLeft')).toEqual({ focus: 'header:regional_guidance' });
  });
});
