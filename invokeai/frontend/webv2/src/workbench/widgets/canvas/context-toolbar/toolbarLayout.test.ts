import { describe, expect, it } from 'vitest';

import {
  fullToolbarWidth,
  resolveToolbarLayout,
  TOOLBAR_GAP_PX,
  TOOLBAR_IDENTITY_FULL_MIN_WIDTH_PX,
  TOOLBAR_PRIMARY_MAX_WIDTH_PX,
  TOOLBAR_REGION_ORDER,
  TOOLBAR_REGION_WIDTH_PX,
  TOOLBAR_STATUS_FULL_MIN_WIDTH_PX,
  type ToolbarLayout,
  type ToolbarRegionId,
} from './toolbarLayout';

const barRegions = (layout: ToolbarLayout): ToolbarRegionId[] =>
  TOOLBAR_REGION_ORDER.filter((region) => layout.regions[region] !== 'menu');

const shape = (layout: ToolbarLayout) => ({
  bar: barRegions(layout),
  geometry: layout.regions.geometry,
  identity: layout.identity,
  status: layout.status,
});

describe('resolveToolbarLayout', () => {
  it('keeps every region in the bar once the full width fits, and nothing beyond that width changes', () => {
    const full = fullToolbarWidth(200);
    expect(full).toBe(108 + 196 + 152 + 64 + 200 + 32 + 236 + 6 * TOOLBAR_GAP_PX);
    const atFull = resolveToolbarLayout({
      reservesToolRegions: true,
      modesWidth: 200,
      primary: 'geometry',
      width: full,
    });
    expect(atFull).toEqual({
      identity: 'full',
      regions: { color: 'bar', geometry: 'bar', intensity: 'bar', modes: 'bar' },
      status: 'full',
    });
    expect(
      resolveToolbarLayout({ reservesToolRegions: true, modesWidth: 200, primary: 'geometry', width: 4000 })
    ).toEqual(atFull);
    expect(
      barRegions(
        resolveToolbarLayout({ reservesToolRegions: true, modesWidth: 200, primary: 'geometry', width: full - 1 })
      )
    ).toEqual(['geometry', 'intensity', 'color']);
  });

  it('compacts identity and status at fixed widths and demotes modes, color, intensity, then geometry', () => {
    expect(TOOLBAR_IDENTITY_FULL_MIN_WIDTH_PX).toBe(108 + TOOLBAR_PRIMARY_MAX_WIDTH_PX + 32 + 236 + 3 * TOOLBAR_GAP_PX);
    expect(TOOLBAR_STATUS_FULL_MIN_WIDTH_PX).toBe(32 + TOOLBAR_PRIMARY_MAX_WIDTH_PX + 32 + 236 + 3 * TOOLBAR_GAP_PX);
    const sequence: Array<[number, ReturnType<typeof shape>]> = [
      [1400, { bar: ['geometry', 'intensity', 'color', 'modes'], geometry: 'bar', identity: 'full', status: 'full' }],
      [1000, { bar: ['geometry', 'intensity', 'color'], geometry: 'bar', identity: 'full', status: 'full' }],
      [800, { bar: ['geometry', 'intensity'], geometry: 'bar', identity: 'full', status: 'full' }],
      [644, { bar: ['geometry'], geometry: 'bar', identity: 'full', status: 'full' }],
      [643, { bar: ['geometry'], geometry: 'bar', identity: 'compact', status: 'full' }],
      // A compact status frees room for intensity again: the secondary regions may gain at a threshold.
      [567, { bar: ['geometry', 'intensity'], geometry: 'bar', identity: 'compact', status: 'compact' }],
      [300, { bar: [], geometry: 'menu', identity: 'compact', status: 'compact' }],
    ];
    for (const [width, expected] of sequence) {
      expect(
        shape(resolveToolbarLayout({ reservesToolRegions: true, modesWidth: 300, primary: null, width })),
        `${width}px`
      ).toEqual(expected);
    }
  });

  it('gives every tool the same identity and status boxes at a width, whatever its primary region costs', () => {
    for (const width of [1400, 700, 640, 560, 452, 340]) {
      const brush = resolveToolbarLayout({ reservesToolRegions: true, modesWidth: null, primary: 'geometry', width });
      const shapeTool = resolveToolbarLayout({ reservesToolRegions: true, modesWidth: 176, primary: 'modes', width });
      const selection = resolveToolbarLayout({ reservesToolRegions: true, modesWidth: 244, primary: 'modes', width });
      expect([shapeTool.identity, selection.identity], `${width}px`).toEqual([brush.identity, brush.identity]);
      expect([shapeTool.status, selection.status], `${width}px`).toEqual([brush.status, brush.status]);
    }
  });

  it('keeps the primary region in the bar past every other region, shrinking geometry to two slots first', () => {
    const modes = resolveToolbarLayout({ reservesToolRegions: true, modesWidth: 300, primary: 'modes', width: 720 });
    expect(barRegions(modes)).toEqual(['modes']);
    expect(modes.identity).toBe('full');
    // A tool's primary never leaves because identity or status upgraded: the thresholds assume the widest primary.
    for (const width of [TOOLBAR_STATUS_FULL_MIN_WIDTH_PX, TOOLBAR_IDENTITY_FULL_MIN_WIDTH_PX]) {
      const layout = resolveToolbarLayout({
        reservesToolRegions: true,
        modesWidth: TOOLBAR_PRIMARY_MAX_WIDTH_PX,
        primary: 'modes',
        width,
      });
      expect(layout.regions.modes, `${width}px`).toBe('bar');
    }
    // A compact identity, compact geometry, More and a compact status: the narrowest bar that shows geometry.
    const narrowestCompact = 32 + 128 + 32 + 104 + 3 * TOOLBAR_GAP_PX;
    const compact = resolveToolbarLayout({
      reservesToolRegions: true,
      modesWidth: null,
      primary: 'geometry',
      width: narrowestCompact,
    });
    expect(shape(compact)).toEqual({
      bar: ['geometry', 'modes'],
      geometry: 'compact',
      identity: 'compact',
      status: 'compact',
    });
    const full = resolveToolbarLayout({
      reservesToolRegions: true,
      modesWidth: null,
      primary: 'geometry',
      width: narrowestCompact + 68,
    });
    expect(full.regions.geometry).toBe('bar');
  });

  it('moves even the primary region into the menu rather than clipping the bar', () => {
    const tooNarrow = resolveToolbarLayout({
      reservesToolRegions: true,
      modesWidth: 400,
      primary: 'modes',
      width: 400,
    });
    expect(shape(tooNarrow)).toEqual({ bar: [], geometry: 'menu', identity: 'compact', status: 'compact' });
    const geometry = resolveToolbarLayout({
      reservesToolRegions: true,
      modesWidth: null,
      primary: 'geometry',
      width: 300,
    });
    expect(geometry.regions.geometry).toBe('menu');
  });

  it('leaves a modes region without width (a hint, or nothing) in the bar at every width, and charges it nothing', () => {
    for (const width of [1400, 700, 400, 100]) {
      expect(
        resolveToolbarLayout({ reservesToolRegions: true, modesWidth: 0, primary: null, width }).regions.modes,
        `${width}px`
      ).toBe('bar');
      expect(
        resolveToolbarLayout({ reservesToolRegions: true, modesWidth: null, primary: null, width }).regions.modes,
        `${width}px`
      ).toBe('bar');
    }
    expect(fullToolbarWidth(null) - fullToolbarWidth(0)).toBe(-TOOLBAR_GAP_PX);
  });

  it('is monotonic for the primary region, identity and status, and for the rest between the thresholds', () => {
    for (const primary of ['geometry', 'modes', null] as const) {
      let previousChrome = -1;
      let previousRegions = -1;
      let previousPrimary = -1;
      for (let width = 100; width <= 1600; width += 4) {
        const layout = resolveToolbarLayout({ reservesToolRegions: true, modesWidth: 240, primary, width });
        const chrome = (layout.identity === 'full' ? 1 : 0) + (layout.status === 'full' ? 2 : 0);
        const regions = barRegions(layout).length * 2 + (layout.regions.geometry === 'bar' ? 1 : 0);
        const primaryScore = primary === null ? 0 : layout.regions[primary] === 'menu' ? 0 : 1;
        expect(chrome, `${primary} ${width}px`).toBeGreaterThanOrEqual(previousChrome);
        expect(primaryScore, `${primary} ${width}px`).toBeGreaterThanOrEqual(previousPrimary);
        if (chrome === previousChrome) {
          expect(regions, `${primary} ${width}px`).toBeGreaterThanOrEqual(previousRegions);
        }
        previousChrome = chrome;
        previousRegions = regions;
        previousPrimary = primaryScore;
      }
    }
  });

  it('charges nothing for the tool regions a hint-only tool does not reserve', () => {
    const hint = resolveToolbarLayout({ modesWidth: 0, primary: null, reservesToolRegions: false, width: 300 });
    expect(hint.regions).toEqual({ color: 'bar', geometry: 'bar', intensity: 'bar', modes: 'bar' });
    expect(fullToolbarWidth(0, false)).toBe(108 + 0 + 32 + 236 + 3 * TOOLBAR_GAP_PX);
  });

  it('reports region widths that add up to the documented fixed sum', () => {
    const { color, geometry, identity, intensity, status } = TOOLBAR_REGION_WIDTH_PX;
    expect(identity + geometry + intensity + color + status).toBe(756);
  });
});
