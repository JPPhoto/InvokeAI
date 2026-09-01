import type { RegionalGuidanceReferenceImage } from '@workbench/canvas-engine/api';

import { documentFrom, layerContract } from '@workbench/canvas-engine/document-model/documentFixtures.testStub';
import { describe, expect, it } from 'vitest';

import { getLayerChildItem, layerChildRowCommand, layerChildRowKey, projectLayerChildRows } from './layerChildRows';
import { buildLayerStackRows } from './layerTreeRows';

const referenceImage = (id: string, overrides: Partial<RegionalGuidanceReferenceImage> = {}) => ({
  config: {
    beginEndStepPct: [0, 1] as [number, number],
    clipVisionModel: 'ViT-H' as const,
    image: null,
    method: 'full' as const,
    model: null,
    type: 'ip_adapter' as const,
    weight: 1,
  },
  id,
  isEnabled: true,
  ...overrides,
});

const regionalWith = (refs: RegionalGuidanceReferenceImage[], overrides = {}) =>
  layerContract('rg1', 'regional_guidance', { referenceImages: refs, ...overrides });

const rowsOf = (document: ReturnType<typeof documentFrom>, id = 'rg1') => {
  const built = buildLayerStackRows(document.stacks, new Set());
  return built.regional_guidance.rows.find((row) => row.id === id)!;
};

describe('projectLayerChildRows', () => {
  it('projects one row per reference image, in order, with enablement and position facts', () => {
    const withImage = referenceImage('ref2', {
      config: { ...referenceImage('ref2').config, image: { imageName: 'img.png', thumbnailUrl: '/thumb.png' } },
      isEnabled: false,
    } as Partial<RegionalGuidanceReferenceImage>);
    const document = documentFrom([regionalWith([referenceImage('ref1'), withImage])]);
    const rows = projectLayerChildRows(rowsOf(document).vm);
    expect(rows.map((row) => row.itemId)).toEqual(['ref1', 'ref2']);
    expect(rows[0]).toMatchObject({
      depth: 1,
      image: null,
      isEnabled: true,
      key: layerChildRowKey('rg1', 'ref1'),
      kind: 'reference-image',
      layerId: 'rg1',
      parentContributing: true,
      posInSet: 1,
      setSize: 2,
      stack: 'regional_guidance',
    });
    expect(rows[1]).toMatchObject({
      image: { imageName: 'img.png', thumbnailUrl: '/thumb.png' },
      isEnabled: false,
      posInSet: 2,
    });
  });

  it('projects nothing for layers without reference images and for other layer types', () => {
    const document = documentFrom([regionalWith([]), layerContract('r1'), layerContract('m1', 'inpaint_mask')]);
    const built = buildLayerStackRows(document.stacks, new Set());
    for (const stack of Object.values(built)) {
      for (const row of stack.rows) {
        expect(projectLayerChildRows(row.vm)).toEqual([]);
      }
    }
  });

  it('reports a disabled or ancestor-disabled parent as not contributing', () => {
    const document = documentFrom([regionalWith([referenceImage('ref1')], { isEnabled: false })]);
    expect(projectLayerChildRows(rowsOf(document).vm)[0]!.parentContributing).toBe(false);
  });

  it('returns the identical array for an unchanged node', () => {
    const document = documentFrom([regionalWith([referenceImage('ref1')])]);
    const vm = rowsOf(document).vm;
    expect(projectLayerChildRows(vm)).toBe(projectLayerChildRows(vm));
  });
});

describe('layerChildRowCommand', () => {
  const target = { itemId: 'ref1', layerId: 'rg1' };

  it('builds a patch-config toggling one item and leaving the others untouched', () => {
    const document = documentFrom([regionalWith([referenceImage('ref1'), referenceImage('ref2')])]);
    const command = layerChildRowCommand(document, target, { isEnabled: false, type: 'set-enabled' });
    expect(command).toMatchObject({ id: 'rg1', type: 'patch-config' });
    const config = command!.config as { referenceImages: RegionalGuidanceReferenceImage[] };
    const before = command!.before as { referenceImages: RegionalGuidanceReferenceImage[] };
    expect(config.referenceImages.map((ref) => [ref.id, ref.isEnabled])).toEqual([
      ['ref1', false],
      ['ref2', true],
    ]);
    expect(before.referenceImages.map((ref) => ref.isEnabled)).toEqual([true, true]);
    // Untouched items keep identity; the toggled one is replaced, never mutated.
    expect(config.referenceImages[1]).toBe(before.referenceImages[1]);
    expect(before.referenceImages[0]!.isEnabled).toBe(true);
  });

  it('builds a removal that drops exactly the addressed item', () => {
    const document = documentFrom([regionalWith([referenceImage('ref1'), referenceImage('ref2')])]);
    const command = layerChildRowCommand(document, target, { type: 'remove' });
    const config = command!.config as { referenceImages: RegionalGuidanceReferenceImage[] };
    expect(config.referenceImages.map((ref) => ref.id)).toEqual(['ref2']);
  });

  it('returns null for a missing layer, a wrong-typed layer, a missing item, and a no-op toggle', () => {
    const document = documentFrom([regionalWith([referenceImage('ref1')]), layerContract('r1')]);
    expect(layerChildRowCommand(document, { itemId: 'ref1', layerId: 'gone' }, { type: 'remove' })).toBeNull();
    expect(layerChildRowCommand(document, { itemId: 'ref1', layerId: 'r1' }, { type: 'remove' })).toBeNull();
    expect(layerChildRowCommand(document, { itemId: 'gone', layerId: 'rg1' }, { type: 'remove' })).toBeNull();
    expect(layerChildRowCommand(document, target, { isEnabled: true, type: 'set-enabled' })).toBeNull();
  });
});

describe('mask modifier rows', () => {
  const maskWith = (overrides = {}) => layerContract('m1', 'inpaint_mask', overrides);
  const maskRow = (document: ReturnType<typeof documentFrom>) =>
    buildLayerStackRows(document.stacks, new Set()).inpaint_mask.rows.find((row) => row.id === 'm1')!;

  it('projects noise then denoise rows with their values and enablement', () => {
    const document = documentFrom([
      maskWith({ denoise: { isEnabled: false, limit: 0.8 }, noise: { isEnabled: true, level: 0.25 } }),
    ]);
    const rows = projectLayerChildRows(maskRow(document).vm);
    expect(rows.map((row) => [row.kind, row.itemId, row.isEnabled, row.value, row.posInSet, row.setSize])).toEqual([
      ['mask-noise', 'noise', true, 0.25, 1, 2],
      ['mask-denoise', 'denoise', false, 0.8, 2, 2],
    ]);
    expect(projectLayerChildRows(maskRow(documentFrom([maskWith()])).vm)).toEqual([]);
  });

  it('toggles and removes a modifier through null-clearing patches', () => {
    const document = documentFrom([maskWith({ noise: { isEnabled: true, level: 0.25 } })]);
    const toggle = layerChildRowCommand(
      document,
      { itemId: 'noise', layerId: 'm1' },
      { isEnabled: false, type: 'set-enabled' }
    );
    expect(toggle).toMatchObject({
      before: { layerType: 'inpaint_mask', noise: { isEnabled: true, level: 0.25 } },
      config: { layerType: 'inpaint_mask', noise: { isEnabled: false, level: 0.25 } },
      id: 'm1',
    });
    const remove = layerChildRowCommand(document, { itemId: 'noise', layerId: 'm1' }, { type: 'remove' });
    expect(remove).toMatchObject({ config: { layerType: 'inpaint_mask', noise: null } });
    expect(layerChildRowCommand(document, { itemId: 'denoise', layerId: 'm1' }, { type: 'remove' })).toBeNull();
    expect(
      layerChildRowCommand(document, { itemId: 'noise', layerId: 'm1' }, { isEnabled: true, type: 'set-enabled' })
    ).toBeNull();
  });

  it('resolves live child items across kinds', () => {
    const document = documentFrom([
      maskWith({ noise: { isEnabled: false, level: 0.5 } }),
      regionalWith([referenceImage('ref1')]),
    ]);
    expect(getLayerChildItem(document, 'm1', 'noise')).toEqual({ isEnabled: false, kind: 'mask-noise' });
    expect(getLayerChildItem(document, 'm1', 'denoise')).toBeNull();
    expect(getLayerChildItem(document, 'rg1', 'ref1')).toEqual({ isEnabled: true, kind: 'reference-image' });
    expect(getLayerChildItem(document, 'rg1', 'gone')).toBeNull();
    expect(getLayerChildItem(document, 'gone', 'noise')).toBeNull();
  });
});
