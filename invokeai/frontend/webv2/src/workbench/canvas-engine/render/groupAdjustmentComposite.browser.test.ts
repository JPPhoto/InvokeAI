import type { CanvasAdjustmentsContract, CanvasRasterLayerContractV2 } from '@workbench/canvas-engine/contracts';
import type { RasterSurface } from '@workbench/canvas-engine/render/raster';
import type { Rect } from '@workbench/canvas-engine/types';

import { groupContract, stacksFrom } from '@workbench/canvas-engine/document-model/documentFixtures.testStub';
import { identity } from '@workbench/canvas-engine/math/mat2d';
import { sampleDocumentColor } from '@workbench/canvas-engine/render/colorSample';
import { compositeDocument } from '@workbench/canvas-engine/render/compositor';
import { createGroupSurfaceCache } from '@workbench/canvas-engine/render/groupSurfaceCache';
import { createLayerCacheStore } from '@workbench/canvas-engine/render/layerCache';
import { createDomRasterBackend } from '@workbench/canvas-engine/render/raster';
import { planBaseRasterComposite, renderRasterComposite } from '@workbench/canvas-engine/render/rasterComposite';
import { describe, expect, it } from 'vitest';

const WIDTH = 64;
const HEIGHT = 64;
const BBOX: Rect = { height: HEIGHT, width: WIDTH, x: 0, y: 0 };

const raster = (id: string, overrides: Partial<CanvasRasterLayerContractV2> = {}): CanvasRasterLayerContractV2 => ({
  blendMode: 'normal',
  id,
  isEnabled: true,
  isLocked: false,
  name: id,
  opacity: 1,
  source: { bitmap: { height: HEIGHT, imageName: id, width: WIDTH }, type: 'paint' },
  transform: { rotation: 0, scaleX: 1, scaleY: 1, x: 0, y: 0 },
  type: 'raster',
  ...overrides,
});

/** Midtone-lifting levels (gamma 2): deliberately NON-affine, so applying it to a
 * composite differs measurably from applying it to each member before blending. */
const gammaStack = (id: string): CanvasAdjustmentsContract => [
  { gamma: 2, id, inBlack: 0, inWhite: 255, isEnabled: true, outBlack: 0, outWhite: 255, type: 'levels' },
];
const invertStack = (id: string): CanvasAdjustmentsContract => [{ id, isEnabled: true, type: 'invert' }];

const sceneFor = (fills: Record<string, string>) => {
  const backend = createDomRasterBackend();
  const caches = createLayerCacheStore(backend);
  for (const [id, color] of Object.entries(fills)) {
    caches.growToRect(id, BBOX);
    const surface = caches.get(id)!.surface;
    surface.ctx.setTransform(1, 0, 0, 1, 0, 0);
    surface.ctx.fillStyle = color;
    surface.ctx.fillRect(0, 0, WIDTH, HEIGHT);
    caches.publishPixels(id);
  }
  return {
    backend,
    caches,
    getLayerSurface: (layerId: string) => {
      const entry = caches.get(layerId)!;
      return Promise.resolve({ rect: entry.rect, surface: entry.surface });
    },
  };
};

const centerPixel = (surface: RasterSurface): number[] => [
  ...surface.ctx.getImageData(WIDTH / 2, HEIGHT / 2, 1, 1).data,
];

const docWith = (nodes: Parameters<typeof stacksFrom>[0]) => ({
  background: 'transparent' as const,
  bbox: BBOX,
  height: HEIGHT,
  selectedLayerId: null,
  stacks: stacksFrom(nodes),
  version: 3 as const,
  width: WIDTH,
});

describe('group adjustment composite', () => {
  it('applies the stack to the group composite, not to each member (the per-leaf bake is measurably wrong)', async () => {
    // 50% red over white inside the group → pink (255,~127,~127);
    // gamma-2 on the COMPOSITE lifts g/b to ~180. Per-member baking would
    // leave g/b near ~127 (gamma fixes 0 and 255), 50+ levels away.
    const document = docWith([
      groupContract('g', [raster('red', { opacity: 0.5 }), raster('white')], {
        adjustments: gammaStack('ga'),
      } as never),
    ]);
    const scene = sceneFor({ red: '#ff0000', white: '#ffffff' });
    const entry = planBaseRasterComposite(document, BBOX);
    expect(entry.groupScopes).toHaveLength(1);

    const surface = await renderRasterComposite(entry, scene);
    const [r, g, b, a] = centerPixel(surface);
    expect(a).toBe(255);
    expect(r).toBe(255);
    expect(Math.abs(g! - 180)).toBeLessThanOrEqual(3);
    expect(Math.abs(b! - 180)).toBeLessThanOrEqual(3);
  });

  it('applies nested stacks inner-first', async () => {
    // Inner group inverts mid-gray 25% red-over-white... keep it simple:
    // inner invert turns white → black; outer gamma-2 keeps black at 0.
    // Reversed order (gamma then invert) would give 255 − 255·sqrt(1) = 0 too,
    // so use a mid value: member is 25% gray (64). invert → 191; gamma-2 on
    // 191 → 255·sqrt(191/255) ≈ 221. Reversed: gamma-2(64) ≈ 128, invert → 127.
    const document = docWith([
      groupContract('outer', [groupContract('inner', [raster('gray')], { adjustments: invertStack('ia') } as never)], {
        adjustments: gammaStack('oa'),
      } as never),
    ]);
    const scene = sceneFor({ gray: '#404040' });
    const surface = await renderRasterComposite(planBaseRasterComposite(document, BBOX), scene);
    const [r] = centerPixel(surface);
    expect(Math.abs(r! - 221)).toBeLessThanOrEqual(3);
  });

  it('draws the same pixels on screen (group surface cache) as the export renderer', async () => {
    const document = docWith([
      groupContract('g', [raster('red', { blendMode: 'multiply', opacity: 0.6 }), raster('white')], {
        adjustments: gammaStack('ga'),
      } as never),
      raster('under'),
    ]);
    const scene = sceneFor({ red: '#ff4040', under: '#2040c0', white: '#c0c0c0' });
    const groupSurfaces = createGroupSurfaceCache({
      createSurface: (w, h) => scene.backend.createSurface(w, h),
      getAdjustedSurface: () => null,
      getCacheEntry: (id) => scene.caches.get(id),
    });

    const screen = scene.backend.createSurface(WIDTH, HEIGHT);
    compositeDocument(screen, document, scene.caches, identity(), {
      backend: scene.backend,
      groupSurface: (scope, members, matrices, exclude) => groupSurfaces.get(scope, members, matrices, exclude),
    });
    const exported = await renderRasterComposite(planBaseRasterComposite(document, BBOX), scene);

    const screenPx = centerPixel(screen);
    const exportPx = centerPixel(exported);
    for (let channel = 0; channel < 4; channel += 1) {
      expect(Math.abs(screenPx[channel]! - exportPx[channel]!)).toBeLessThanOrEqual(1);
    }
    // And a second composite reuses the cached group surface (same pixels).
    const again = scene.backend.createSurface(WIDTH, HEIGHT);
    compositeDocument(again, document, scene.caches, identity(), {
      backend: scene.backend,
      groupSurface: (scope, members, matrices, exclude) => groupSurfaces.get(scope, members, matrices, exclude),
    });
    expect(centerPixel(again)).toEqual(screenPx);
  });

  it('resolves sibling scopes nested inside a parent scope with correct member indexing', async () => {
    // outer gamma-2 group holding: invert-group [a], plain b, invert-group [d].
    // a=#404040 → invert 191 → outer gamma ≈221. b=#404040 → outer gamma ≈128.
    // d covers nothing at centre (checked via left pixel below).
    const document = docWith([
      groupContract(
        'outer',
        [
          groupContract('i1', [raster('a')], { adjustments: invertStack('ia') } as never),
          raster('b', { opacity: 0.0 }),
          groupContract('i2', [raster('d', { opacity: 0.0 })], { adjustments: invertStack('ib') } as never),
        ],
        { adjustments: gammaStack('oa') } as never
      ),
    ]);
    const scene = sceneFor({ a: '#404040', b: '#404040', d: '#404040' });
    const exported = await renderRasterComposite(planBaseRasterComposite(document, BBOX), scene);
    const [r] = centerPixel(exported);
    expect(Math.abs(r! - 221)).toBeLessThanOrEqual(3);

    const groupSurfaces = createGroupSurfaceCache({
      createSurface: (w, h) => scene.backend.createSurface(w, h),
      getAdjustedSurface: () => null,
      getCacheEntry: (id) => scene.caches.get(id),
    });
    const screen = scene.backend.createSurface(WIDTH, HEIGHT);
    compositeDocument(screen, document, scene.caches, identity(), {
      backend: scene.backend,
      groupSurface: (scope, members, matrices, exclude) => groupSurfaces.get(scope, members, matrices, exclude),
    });
    expect(Math.abs(centerPixel(screen)[0]! - 221)).toBeLessThanOrEqual(3);
  });

  it('color-samples through a group stack when the providers are wired', () => {
    const document = docWith([groupContract('g', [raster('gray')], { adjustments: invertStack('ia') } as never)]);
    const scene = sceneFor({ gray: '#404040' });
    const groupSurfaces = createGroupSurfaceCache({
      createSurface: (w, h) => scene.backend.createSurface(w, h),
      getAdjustedSurface: () => null,
      getCacheEntry: (id) => scene.caches.get(id),
    });
    const point = { x: WIDTH / 2, y: HEIGHT / 2 };
    const raw = sampleDocumentColor(document, scene.caches, scene.backend, point);
    expect(raw?.r).toBe(0x40);
    const adjusted = sampleDocumentColor(document, scene.caches, scene.backend, point, {
      groupSurface: (scope, members, matrices, exclude) => groupSurfaces.get(scope, members, matrices, exclude),
    });
    expect(adjusted?.r).toBe(255 - 0x40);
  });

  it('keeps identity and pass-through groups on the flat path and keys the plan by group stacks', () => {
    const flat = docWith([groupContract('g', [raster('white')])]);
    expect(planBaseRasterComposite(flat, BBOX).groupScopes).toBeUndefined();

    const adjusted = docWith([groupContract('g', [raster('white')], { adjustments: gammaStack('ga') } as never)]);
    const inverted = docWith([groupContract('g', [raster('white')], { adjustments: invertStack('ia') } as never)]);
    expect(planBaseRasterComposite(adjusted, BBOX).key).not.toBe(planBaseRasterComposite(flat, BBOX).key);
    expect(planBaseRasterComposite(adjusted, BBOX).key).not.toBe(planBaseRasterComposite(inverted, BBOX).key);
  });
});
