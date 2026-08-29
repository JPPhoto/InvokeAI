import type { LayerExportGuard } from '@workbench/canvas-engine/engine';
import type { FilterOperationSessionState } from '@workbench/canvas-operations/filterOperationSession';
import type { ComponentProps } from 'react';

import { ChakraProvider } from '@chakra-ui/react';
import { system } from '@theme/system';
import { attachCanvasOperations } from '@workbench/canvas-operations/operationAccess';
import { createInstance } from 'i18next';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import {
  FilterModes,
  FilterMore,
  FilterStatus,
  getFilterActionEligibility,
  getFilterSaveTargetEligibility,
  getFilterStatusTranslationKey,
} from './FilterOptions';

const englishCatalogModules = import.meta.glob('../../../../../public/locales/en.json', {
  eager: true,
  import: 'default',
});
const enCatalog = Object.values(englishCatalogModules)[0] as Record<string, unknown>;
const testI18n = createInstance();
await testI18n.init({
  initAsync: false,
  lng: 'en',
  resources: { en: { translation: enCatalog } },
});

const state = (patch: Partial<FilterOperationSessionState> = {}): FilterOperationSessionState => ({
  autoProcess: true,
  draft: { settings: {}, type: 'canny_edge_detection' },
  error: null,
  initialFilter: null,
  layerId: 'layer-1',
  layerName: 'Portrait',
  layerType: 'raster',
  preview: null,
  status: 'ready',
  ...patch,
});

describe('getFilterActionEligibility', () => {
  it('allows processing/reset/cancel before a preview exists', () => {
    expect(getFilterActionEligibility(state())).toEqual({
      canApply: false,
      canCancel: true,
      canEdit: true,
      canProcess: true,
      canReset: true,
      canSave: false,
    });
  });

  it('enables apply/save only for a ready preview', () => {
    const preview = {
      guard: {} as LayerExportGuard,
      height: 10,
      imageName: 'filtered',
      origin: { x: 0, y: 0 },
      rect: { height: 10, width: 10, x: 0, y: 0 },
      width: 10,
    } as NonNullable<FilterOperationSessionState['preview']>;
    const eligibility = getFilterActionEligibility(state({ preview }));
    expect(eligibility).toMatchObject({ canApply: true, canSave: true });
    expect(getFilterSaveTargetEligibility(eligibility)).toEqual({ control: true, raster: true });
  });

  it.each(['processing', 'committing'] as const)('disables ordinary actions while %s', (status) => {
    expect(getFilterActionEligibility(state({ status }))).toEqual({
      canApply: false,
      canCancel: true,
      canEdit: false,
      canProcess: false,
      canReset: false,
      canSave: false,
    });
  });

  it('disables mutating actions under an external interaction lock but preserves Cancel', () => {
    const eligibility = getFilterActionEligibility(state(), true);
    expect(eligibility).toEqual({
      canApply: false,
      canCancel: true,
      canEdit: false,
      canProcess: false,
      canReset: false,
      canSave: false,
    });
    expect(getFilterSaveTargetEligibility(eligibility)).toEqual({ control: false, raster: false });
  });

  it('disables Process for Spandrel until a compatible model is selected', () => {
    expect(
      getFilterActionEligibility(state({ draft: { settings: { model: null }, type: 'spandrel_filter' } }))
    ).toMatchObject({ canProcess: false });
    expect(
      getFilterActionEligibility(
        state({
          draft: {
            settings: {
              model: {
                base: 'any',
                hash: 'blake3-hash',
                key: 'upscale',
                name: 'Upscaler',
                type: 'spandrel_image_to_image',
              },
            },
            type: 'spandrel_filter',
          },
        })
      )
    ).toMatchObject({ canProcess: true });
  });

  it('disables Process for stale partial Spandrel identifiers', () => {
    expect(
      getFilterActionEligibility(
        state({
          draft: {
            settings: {
              model: { base: 'any', hash: '', key: 'upscale', name: 'Upscaler', type: 'spandrel_image_to_image' },
            },
            type: 'spandrel_filter',
          },
        })
      )
    ).toMatchObject({ canProcess: false });
  });
});

describe('getFilterStatusTranslationKey', () => {
  it('maps each session status to its message key', () => {
    expect(getFilterStatusTranslationKey('processing')).toBe('widgets.layers.rasterFilter.running');
    expect(getFilterStatusTranslationKey('committing')).toBe('widgets.layers.rasterFilter.statusCommitting');
    expect(getFilterStatusTranslationKey('error')).toBe('widgets.layers.rasterFilter.statusError');
    expect(getFilterStatusTranslationKey('ready')).toBe('widgets.layers.selectObject.statusReady');
  });
});

const renderRegions = (session: FilterOperationSessionState) => {
  const operations = {
    cancelFilterOperation: vi.fn(),
    commitFilterOperation: vi.fn(),
    getFilterSessionState: () => session,
    processFilterOperation: vi.fn(),
    resetFilterOperation: vi.fn(),
    setFilterOperationAutoProcess: vi.fn(),
    subscribeFilterSession: () => () => undefined,
    updateFilterOperation: vi.fn(),
  };
  const engine = {};
  attachCanvasOperations(engine, operations as never);
  const render = (element: React.ReactElement) =>
    renderToStaticMarkup(
      createElement(
        ChakraProvider,
        { value: system } as ComponentProps<typeof ChakraProvider>,
        createElement(I18nextProvider, { i18n: testI18n }, element)
      )
    );
  return {
    modes: render(
      createElement(FilterModes, { engine: engine as never, isSurfaceInteractionLocked: false, placement: 'bar' })
    ),
    more: render(
      createElement(FilterMore, { engine: engine as never, isSurfaceInteractionLocked: false, placement: 'menu' })
    ),
    operations,
    status: render(
      createElement(FilterStatus, { compact: false, engine: engine as never, isExternalInteractionLocked: false })
    ),
  };
};

describe('filter operation regions', () => {
  it('splits type and auto-process into the bar, parameters and secondary commands into More, and keeps Apply / Cancel in status', () => {
    const { modes, more, status } = renderRegions(
      state({ draft: { settings: { high_threshold: 200, low_threshold: 100 }, type: 'canny_edge_detection' } })
    );

    expect(modes).toContain('aria-label="Filter"');
    expect(modes).toContain('>Auto<');
    expect(modes).not.toContain('>Process<');

    expect(more).not.toContain('aria-label="Filter"');
    expect(more.indexOf('>Process<')).toBeLessThan(more.indexOf('>Reset<'));
    expect(more.indexOf('>Reset<')).toBeLessThan(more.indexOf('>Raster layer<'));
    expect(more.indexOf('>Raster layer<')).toBeLessThan(more.indexOf('>Control layer<'));

    expect(status).toContain('Portrait · Raster layer');
    expect(status).toContain('role="status"');
    expect(status.indexOf('>Filter<')).toBeLessThan(status.indexOf('>Apply<'));
    expect(status.indexOf('>Apply<')).toBeLessThan(status.indexOf('>Cancel<'));
  });

  it('disables Process and Auto while processing and keeps Cancel live', () => {
    const { modes, more, status } = renderRegions(state({ status: 'processing' }));

    const processIdx = more.indexOf('>Process<');
    const processButtonTag = more.slice(more.lastIndexOf('<button', processIdx), processIdx);
    expect(processButtonTag).toContain('disabled=""');
    expect(processButtonTag).toContain('data-loading=""');

    const autoIdx = modes.indexOf('>Auto<');
    expect(modes.slice(modes.lastIndexOf('<button', autoIdx), autoIdx)).toContain('disabled=""');

    const cancelIdx = status.indexOf('>Cancel<');
    expect(status.slice(status.lastIndexOf('<button', cancelIdx), cancelIdx)).not.toContain('disabled=""');
  });

  it('marks the Auto chip pressed state from the session', () => {
    expect(renderRegions(state({ autoProcess: true })).modes).toContain('aria-pressed="true"');
    expect(renderRegions(state({ autoProcess: false })).modes).toContain('aria-pressed="false"');
  });
});
