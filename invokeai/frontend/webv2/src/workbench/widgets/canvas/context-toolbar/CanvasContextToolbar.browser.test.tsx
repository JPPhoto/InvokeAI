/* oxlint-disable react-perf/jsx-no-new-function-as-prop */
import type { ToolId } from '@workbench/canvas-engine/api';
import type { CanvasOperationState } from '@workbench/canvas-operations/api';
import type { CanvasEngine } from '@workbench/canvas-operations/createCanvasEngine';
import type { FilterOperationSessionState } from '@workbench/canvas-operations/filterOperationSession';
import type { SamSessionSnapshot } from '@workbench/canvas-operations/operationTypes';
import type { CanvasProjectMutationPort } from '@workbench/canvasProjectMutationPort';
import type { Project } from '@workbench/projectContracts';

import { ChakraProvider } from '@chakra-ui/react';
import { system } from '@theme/system';
import {
  createEngineRegistry,
  type EngineDeps,
  type EngineRegistry,
} from '@workbench/canvas-operations/engineRegistry';
import { attachCanvasOperations } from '@workbench/canvas-operations/operationAccess';
import { createEmptyCanvasState } from '@workbench/canvasMigration';
import { createInitialWorkbenchState } from '@workbench/workbenchState';
import { createInstance } from 'i18next';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { CanvasContextToolbar, TOOLBAR_INSET_PX } from './CanvasContextToolbar';
import { hasToolRegions, OPERATION_PRESENTATION_ADAPTERS, TOOL_PRESENTATION_ADAPTERS } from './toolAdapters';
import { resolveToolbarLayout, TOOLBAR_HEIGHT_PX, TOOLBAR_REGION_ORDER } from './toolbarLayout';

const harness = vi.hoisted(() => ({ project: null as Project | null }));

vi.mock('@workbench/WorkbenchContext', () => ({
  useActiveProjectSelector: (selector: (project: Project) => unknown) => selector(harness.project!),
  useOptionalWorkbenchCommands: () => null,
}));
vi.mock('@workbench/useCanvasProjectMutationDispatch', () => ({
  useCanvasProjectMutationDispatch: () => () => true,
}));
const i18n = createInstance();
beforeAll(async () => {
  // The catalog is a public asset: the dev server serves it, JavaScript cannot import it.
  const translation = (await (await fetch('/locales/en.json')).json()) as Record<string, unknown>;
  await i18n.init({ initAsync: false, lng: 'en', resources: { en: { translation } } });
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOOL_IDS = Object.keys(TOOL_PRESENTATION_ADAPTERS) as ToolId[];
/** 452px is the canvas widget at 1440 with the default Edit preset; 336px (320 + the insets) is the narrowest bar that shows geometry. */
const WIDTHS = [1400, 1000, 700, 600, 540, 452, 336];
const BAR_REGIONS = [...TOOLBAR_REGION_ORDER, 'identity', 'more', 'status'] as const;
type BarRegion = (typeof BAR_REGIONS)[number];

const createEngineDeps = (): EngineDeps => {
  const state = createEmptyCanvasState(64, 64);
  const mutationPort: CanvasProjectMutationPort = {
    commitEdit: () => undefined,
    dispatch: () => false,
    getCanvasState: () => state,
    subscribe: () => () => undefined,
  };
  return {
    getMainModelBase: () => null,
    imageResolver: () => Promise.resolve(new Blob()),
    mutationPort,
    reportError: () => undefined,
  };
};

const filterSession = (): FilterOperationSessionState => ({
  autoProcess: true,
  draft: { settings: { high_threshold: 200, low_threshold: 100 }, type: 'canny_edge_detection' },
  error: null,
  initialFilter: null,
  layerId: 'layer-1',
  layerName: 'Portrait',
  layerType: 'raster',
  preview: null,
  status: 'ready',
});

const samSession = (): SamSessionSnapshot => ({
  applyPolygonRefinement: false,
  autoProcess: false,
  error: null,
  hasPreview: false,
  input: { prompt: 'a cat', type: 'prompt' },
  invert: false,
  isolatedPreview: true,
  layerName: 'Layer 1',
  layerType: 'raster',
  model: 'segment-anything-2-large',
  pointLabel: 'include',
  sourceRect: { height: 20, width: 20, x: 0, y: 0 },
  status: 'ready',
});

/** Operation state the toolbar reads, driven by the test instead of a backend. */
const createFakeOperations = () => {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  let filter: FilterOperationSessionState | null = null;
  let sam: SamSessionSnapshot | null = null;
  let state: CanvasOperationState = { status: 'idle' };
  const noop = vi.fn();
  return {
    cancelFilterOperation: noop,
    cancelSelectObjectSession: noop,
    commitFilterOperation: noop,
    getFilterSessionState: () => filter,
    getOperationState: () => state,
    getSamSessionState: () => sam,
    processFilterOperation: noop,
    resetFilterOperation: noop,
    setFilterOperationAutoProcess: noop,
    start: (kind: 'filter' | 'select-object' | null) => {
      filter = kind === 'filter' ? filterSession() : null;
      sam = kind === 'select-object' ? samSession() : null;
      state = kind
        ? { error: null, identity: { kind, layerId: 'layer-1', projectId: 'p' }, phase: 'ready', status: 'active' }
        : { status: 'idle' };
      listeners.forEach((listener) => listener());
    },
    subscribeFilterSession: subscribe,
    subscribeOperation: subscribe,
    subscribeSamSession: subscribe,
    updateFilterOperation: noop,
    updateSelectObjectSession: noop,
  };
};

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let registry: EngineRegistry | null = null;
let engine: CanvasEngine | null = null;
let operations: ReturnType<typeof createFakeOperations> | null = null;

const settle = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );

const mount = async (width: number, locked = false) => {
  if (!host) {
    harness.project = { ...createInitialWorkbenchState().projects[0]!, id: 'p' };
    host = document.createElement('div');
    host.style.width = `${width}px`;
    host.style.marginLeft = '13px';
    document.body.append(host);
    root = createRoot(host);
    registry = createEngineRegistry({ gracePeriodMs: 0 });
    engine = registry.getOrCreateEngine('p', createEngineDeps());
    operations = createFakeOperations();
    attachCanvasOperations(engine, operations as never);
  } else {
    host.style.width = `${width}px`;
  }
  await act(() => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <ChakraProvider value={system}>
          <CanvasContextToolbar engine={engine} isSurfaceInteractionLocked={locked} />
        </ChakraProvider>
      </I18nextProvider>
    );
  });
  await settle();
};

const selectTool = async (toolId: ToolId) => {
  await act(() => engine!.tools.setTool(toolId));
  await settle();
};

const toolbar = () => host!.querySelector<HTMLElement>('[data-canvas-context-toolbar]')!;
const region = (id: BarRegion) => toolbar().querySelector<HTMLElement>(`[data-region="${id}"]`)!;
const rectOf = (element: Element) => {
  const { height, left, width } = element.getBoundingClientRect();
  return { height: Math.round(height), left: Math.round(left), width: Math.round(width) };
};
const barRect = (id: BarRegion) => {
  const element = region(id);
  return element.dataset.placement === 'menu' || element.getClientRects().length === 0 ? null : rectOf(element);
};

afterEach(async () => {
  await act(() => root?.unmount());
  host?.remove();
  registry?.releaseEngine('p');
  host = null;
  root = null;
  registry = null;
  engine = null;
  operations = null;
});

describe('CanvasContextToolbar geometry', () => {
  it('keeps one 40px row at the widget edge and the same region boxes for every tool at every width', async () => {
    await mount(WIDTHS[0]!);
    for (const width of WIDTHS) {
      await mount(width);
      const boxes = new Map<BarRegion, ReturnType<typeof rectOf>>();
      for (const toolId of TOOL_IDS) {
        await selectTool(toolId);
        const bar = rectOf(toolbar());
        expect(bar, `${toolId} @ ${width}`).toEqual({ height: TOOLBAR_HEIGHT_PX, left: 13, width });
        expect(rectOf(region('identity')).left, `${toolId} identity @ ${width}`).toBe(13 + TOOLBAR_INSET_PX);
        expect(toolbar().scrollHeight, `${toolId} wraps @ ${width}`).toBeLessThanOrEqual(toolbar().clientHeight);
        expect(toolbar().scrollWidth, `${toolId} clips @ ${width}`).toBeLessThanOrEqual(toolbar().clientWidth);
        for (const id of BAR_REGIONS) {
          const rect = barRect(id);
          if (!rect || id === 'modes' || id === 'more') {
            continue;
          }
          const seen = boxes.get(id);
          if (seen) {
            expect(rect, `${toolId} ${id} @ ${width}`).toEqual(seen);
          } else {
            boxes.set(id, rect);
          }
        }
      }
    }
  });

  it('places the bar regions exactly where the layout resolver says, and never below the clipping width', async () => {
    await mount(700);
    for (const toolId of ['brush', 'shape', 'lasso', 'view'] as const) {
      await selectTool(toolId);
      const adapter = TOOL_PRESENTATION_ADAPTERS[toolId];
      const layout = resolveToolbarLayout({
        modesWidth: adapter.modes?.width ?? 0,
        primary: adapter.primary,
        reservesToolRegions: hasToolRegions(adapter),
        width: 700 - 2 * TOOLBAR_INSET_PX,
      });
      for (const id of TOOLBAR_REGION_ORDER) {
        expect(region(id).dataset.placement, `${toolId} ${id}`).toBe(layout.regions[id]);
      }
      expect(region('status').getBoundingClientRect().right, toolId).toBeLessThanOrEqual(13 + 700 - TOOLBAR_INSET_PX);
    }
  });

  it('shares the X and Y fields between move, transform and the frame', async () => {
    await mount(1400);
    for (const width of [1400, 700]) {
      await mount(width);
      const positions = new Map<string, ReturnType<typeof rectOf>>();
      for (const toolId of ['move', 'transform', 'bbox'] as const) {
        await selectTool(toolId);
        for (const name of ['X', 'Y']) {
          const rect = rectOf(page.getByRole('spinbutton', { exact: true, name }).element());
          const seen = positions.get(name);
          if (seen) {
            expect(rect, `${toolId} ${name} @ ${width}`).toEqual(seen);
          } else {
            positions.set(name, rect);
          }
        }
      }
    }
  });

  it('never unmounts the shell or a region slot across every tool and an operation start', async () => {
    await mount(1000);
    const before = [toolbar(), ...BAR_REGIONS.map((id) => region(id))];
    for (const toolId of TOOL_IDS) {
      await selectTool(toolId);
    }
    await act(() => operations!.start('filter'));
    await settle();
    await act(() => operations!.start('select-object'));
    await settle();
    await act(() => operations!.start(null));
    await settle();
    expect([toolbar(), ...BAR_REGIONS.map((id) => region(id))]).toEqual(before);
  });

  it('keeps identity, geometry and status in place when an operation starts, and hands modes to it', async () => {
    for (const width of [1400, 540]) {
      await mount(width);
      await selectTool('brush');
      const idle = { geometry: barRect('geometry'), identity: barRect('identity'), status: barRect('status') };
      await act(() => operations!.start('filter'));
      await settle();
      // At 540px the filter's controls (its primary region) outrank the inert brush geometry, which moves to More.
      expect(
        {
          geometry: width === 540 ? idle.geometry : barRect('geometry'),
          identity: barRect('identity'),
          status: barRect('status'),
        },
        `${width}`
      ).toEqual(idle);
      expect(region('geometry').hasAttribute('inert'), `${width}`).toBe(true);
      expect(region('modes').hasAttribute('inert'), `${width}`).toBe(false);
      await expect.element(page.getByRole('button', { exact: true, name: 'Apply' })).toBeDisabled();
      await expect.element(page.getByRole('button', { exact: true, name: 'Cancel' })).toBeEnabled();
      await act(() => operations!.start(null));
      await settle();
    }
  });

  it('declares modes widths no narrower than the content they hold', async () => {
    await mount(2000);
    // Hints truncate, so only the controls count against the declared width.
    const check = (label: string, declared: number) => {
      const modes = region('modes');
      expect(modes.dataset.placement, label).toBe('bar');
      const controls = [...modes.children].filter(
        (child) => !child.hasAttribute('data-toolbar-hint') && getComputedStyle(child).position !== 'absolute'
      );
      const width =
        controls.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) + 8 * (controls.length - 1);
      expect(
        Math.ceil(width),
        `${label}: ${controls.map((child) => Math.ceil(child.getBoundingClientRect().width)).join('+')}`
      ).toBeLessThanOrEqual(declared);
    };
    for (const toolId of TOOL_IDS) {
      const adapter = TOOL_PRESENTATION_ADAPTERS[toolId];
      if (!adapter.modes) {
        continue;
      }
      await selectTool(toolId);
      check(toolId, adapter.modes.width);
    }
    await selectTool('brush');
    for (const kind of ['filter', 'select-object'] as const) {
      await act(() => operations!.start(kind));
      await settle();
      check(kind, OPERATION_PRESENTATION_ADAPTERS[kind].modes!.width);
    }
  });
});

describe('CanvasContextToolbar keyboard', () => {
  it('moves displaced regions into the More menu and keeps them reachable from the keyboard', async () => {
    await mount(540);
    await selectTool('brush');
    expect(region('intensity').dataset.placement).toBe('menu');
    expect(page.getByRole('slider', { exact: true, name: 'Opacity' }).query()).toBeNull();
    const more = page.getByRole('button', { exact: true, name: 'More options' });
    await act(async () => {
      (more.element() as HTMLElement).focus();
      await userEvent.keyboard('{Enter}');
    });
    await expect.element(page.getByRole('slider', { exact: true, name: 'Opacity' })).toBeVisible();
    await expect.element(page.getByRole('button', { exact: true, name: 'Pen pressure affects width' })).toBeVisible();
    await act(() => userEvent.keyboard('{Escape}'));
    await expect.element(more).toHaveFocus();
  });

  it('disables More for a tool with nothing to overflow and keeps its box', async () => {
    await mount(1400);
    await selectTool('view');
    await expect.element(page.getByRole('button', { exact: true, name: 'More options' })).toBeDisabled();
    expect(rectOf(region('more')).width).toBe(32);
    await expect.element(page.getByText('Drag to pan and scroll to zoom.', { exact: true })).toBeVisible();
    await selectTool('brush');
    await expect.element(page.getByRole('button', { exact: true, name: 'More options' })).toBeEnabled();
  });

  it('reaches every bar control by Tab, in bar order, and the status actions last', async () => {
    await mount(1400);
    await selectTool('brush');
    const visited: string[] = [];
    (toolbar().querySelector<HTMLElement>('[role="slider"]') ?? toolbar()).focus();
    for (let step = 0; step < 12; step += 1) {
      const active = document.activeElement as HTMLElement | null;
      if (!active || !toolbar().contains(active)) {
        break;
      }
      visited.push(active.getAttribute('aria-label') ?? active.textContent ?? '');
      await act(() => userEvent.keyboard('{Tab}'));
    }
    // Idle Apply / Cancel are disabled, so the tab order ends at More.
    expect(visited).toEqual(['Brush size', 'Brush size', 'Opacity', 'Opacity', 'Brush color', 'More options']);

    await act(() => operations!.start('filter'));
    await settle();
    const withOperation: string[] = [];
    (toolbar().querySelector<HTMLElement>('[data-region="modes"] [role="combobox"]') ?? toolbar()).focus();
    for (let step = 0; step < 12; step += 1) {
      const active = document.activeElement as HTMLElement | null;
      if (!active || !toolbar().contains(active)) {
        break;
      }
      withOperation.push(active.getAttribute('aria-label') ?? active.textContent ?? '');
      await act(() => userEvent.keyboard('{Tab}'));
    }
    // The brush regions are inert while the filter runs; its own controls and Cancel take their place
    // (the type select is named by its value).
    expect(withOperation).toEqual(['Canny', 'Auto', 'More options', 'Cancel']);
  });
});
