/* oxlint-disable react-perf/jsx-no-new-function-as-prop */
import type { CanvasOperationState } from '@workbench/canvas-operations/api';
import type { CanvasEngine } from '@workbench/canvas-operations/createCanvasEngine';
import type { FilterOperationSessionState } from '@workbench/canvas-operations/filterOperationSession';
import type { CanvasProjectMutationPort } from '@workbench/canvasProjectMutationPort';
import type { Project } from '@workbench/projectContracts';

import { ChakraProvider } from '@chakra-ui/react';
import { system } from '@theme/system';
import {
  groupContract,
  layerContract,
  stacksFrom,
} from '@workbench/canvas-engine/document-model/documentFixtures.testStub';
import {
  createEngineRegistry,
  type EngineDeps,
  type EngineRegistry,
} from '@workbench/canvas-operations/engineRegistry';
import { attachCanvasOperations } from '@workbench/canvas-operations/operationAccess';
import { createEmptyCanvasDocument, createEmptyCanvasState } from '@workbench/canvasMigration';
import { applyCanvasProjectMutation } from '@workbench/canvasProjectMutations';
import { createInitialWorkbenchState } from '@workbench/workbenchState';
import { createInstance } from 'i18next';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

const harness = vi.hoisted(() => ({ engine: null as unknown, project: null as Project | null }));

vi.mock('@workbench/WorkbenchContext', () => ({
  useActiveProjectSelector: (selector: (project: Project) => unknown) => selector(harness.project!),
  useOptionalWorkbenchCommands: () => null,
}));
vi.mock('@workbench/useCanvasProjectMutationDispatch', () => ({
  useCanvasProjectMutationDispatch: () => () => true,
}));
vi.mock('@workbench/widgets/canvas/useCanvasEngine', () => ({ useCanvasEngine: () => harness.engine }));

import type { LayerEditorPaneLayout } from './editorPaneLayout';

import { LAYER_EDITOR_PANE_DEFAULTS } from './editorPaneLayout';
import { LayerEditorPanes } from './LayerEditorPanes';
import { PropertiesPane } from './PropertiesPane';
import { TransformPane } from './TransformPane';

const i18n = createInstance();
beforeAll(async () => {
  const translation = (await (await fetch('/locales/en.json')).json()) as Record<string, unknown>;
  await i18n.init({ initAsync: false, lng: 'en', resources: { en: { translation } } });
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The engine reads the harness project's canvas, so document edits resolve against the layers the views show. */
const createEngineDeps = (): EngineDeps => {
  const mutationPort: CanvasProjectMutationPort = {
    commitEdit: () => undefined,
    dispatch: () => false,
    getCanvasState: () => harness.project?.canvas ?? createEmptyCanvasState(64, 64),
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

const createFakeOperations = () => {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  let filter: FilterOperationSessionState | null = null;
  let state: CanvasOperationState = { status: 'idle' };
  return {
    cancelFilterOperation: vi.fn(),
    commitFilterOperation: vi.fn(),
    getFilterSessionState: () => filter,
    getOperationState: () => state,
    getSamSessionState: () => null,
    processFilterOperation: vi.fn(),
    resetFilterOperation: vi.fn(),
    setFilterOperationAutoProcess: vi.fn(),
    start: (running: boolean) => {
      filter = running ? filterSession() : null;
      state = running
        ? {
            error: null,
            identity: { kind: 'filter', layerId: 'layer-1', projectId: 'p' },
            phase: 'ready',
            status: 'active',
          }
        : { status: 'idle' };
      listeners.forEach((listener) => listener());
    },
    subscribeFilterSession: subscribe,
    subscribeOperation: subscribe,
    subscribeSamSession: subscribe,
    updateFilterOperation: vi.fn(),
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

const IDENTITY = { rotation: 0, scaleX: 1, scaleY: 1, x: 0, y: 0 };

type Selection = 'none' | 'layer' | 'group';

const mount = async (View: typeof PropertiesPane, selection: Selection = 'none') => {
  const base = { ...createInitialWorkbenchState().projects[0]!, id: 'p' };
  const nodes =
    selection === 'none'
      ? []
      : selection === 'layer'
        ? [layerContract('l0', 'raster', { name: 'Paint', transform: { ...IDENTITY, rotation: 0.5, x: 10.4 } })]
        : [groupContract('g0', [layerContract('l0', 'raster', { name: 'Paint' })], { name: 'Folder' })];
  harness.project = applyCanvasProjectMutation(base, {
    document: {
      ...createEmptyCanvasDocument(),
      selectedLayerId: selection === 'none' ? null : selection === 'layer' ? 'l0' : 'g0',
      stacks: stacksFrom(nodes),
    },
    type: 'replaceCanvasDocument',
  });
  host = document.createElement('div');
  host.style.cssText = 'width:450px;height:600px;';
  document.body.append(host);
  root = createRoot(host);
  registry = createEngineRegistry({ gracePeriodMs: 0 });
  engine = registry.getOrCreateEngine('p', createEngineDeps());
  operations = createFakeOperations();
  attachCanvasOperations(engine, operations as never);
  harness.engine = engine;
  await act(() => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <ChakraProvider value={system}>
          <View />
        </ChakraProvider>
      </I18nextProvider>
    );
  });
  await settle();
};

afterEach(async () => {
  await act(() => root?.unmount());
  host?.remove();
  registry?.releaseEngine('p');
  host = null;
  root = null;
  registry = null;
  engine = null;
  harness.engine = null;
});

let paneHarnessLayout: LayerEditorPaneLayout = { ...LAYER_EDITOR_PANE_DEFAULTS };
const LayerEditorPanesHarness = () => {
  const [layout, setLayout] = useState(paneHarnessLayout);
  return <LayerEditorPanes layout={layout} onLayoutChange={setLayout} />;
};

describe('Properties pane', () => {
  it('shows the active tool as labelled rows and swaps them with the tool', async () => {
    await mount(PropertiesPane);
    await act(() => engine!.tools.setTool('brush'));
    await settle();
    expect(host!.textContent).toContain('Brush');
    await expect.element(page.getByRole('slider', { exact: true, name: 'Brush size' })).toBeVisible();
    await expect.element(page.getByRole('slider', { exact: true, name: 'Opacity' })).toBeVisible();
    await expect.element(page.getByRole('button', { exact: true, name: 'Brush color' })).toBeVisible();
    await expect.element(page.getByRole('button', { exact: true, name: 'Pen pressure affects width' })).toBeVisible();

    await act(() => engine!.tools.setTool('view'));
    await settle();
    expect(page.getByRole('slider', { exact: true, name: 'Brush size' }).query()).toBeNull();
    expect(host!.textContent).toContain('Drag to pan and scroll to zoom.');
  });

  it('puts a running operation first with Cancel, locks the tool rows in place and hands them focus over', async () => {
    await mount(PropertiesPane);
    await act(() => engine!.tools.setTool('brush'));
    await settle();
    await act(() => page.getByRole('slider', { exact: true, name: 'Brush size' }).element().focus());
    await act(() => operations!.start(true));
    await settle();
    expect(host!.textContent?.indexOf('Operation')).toBeLessThan(host!.textContent?.indexOf('Tool') ?? -1);
    const cancel = page.getByRole('button', { exact: true, name: 'Cancel' });
    await expect.element(cancel).toBeEnabled();
    await expect.element(page.getByRole('button', { exact: true, name: 'Apply' })).toBeDisabled();
    expect(document.activeElement).toBe(cancel.element());
    expect(host!.querySelector('[role="group"][inert]')?.getAttribute('aria-label')).toBe('Tool');
    await act(() => operations!.start(false));
    await settle();
    expect(host!.querySelector('[inert]')).toBeNull();
  });
});

describe('Transform pane', () => {
  it('disables its fields with nothing selected and commits one patch per field for a selected layer', async () => {
    await mount(TransformPane);
    expect(host!.textContent).toContain('No layer selected');
    await expect.element(page.getByRole('spinbutton', { exact: true, name: 'X' })).toBeDisabled();

    await act(() => root?.unmount());
    host?.remove();
    registry?.releaseEngine('p');
    await mount(TransformPane, 'layer');
    const commit = vi.spyOn(engine!.layers, 'commitPrepared');
    const x = page.getByRole('spinbutton', { exact: true, name: 'X' });
    await expect.element(x).toBeEnabled();
    await expect.element(x).toHaveValue('10');
    await act(async () => {
      await userEvent.click(x);
      await userEvent.tab();
      await userEvent.tab();
    });
    expect(commit, 'focus and blur must not commit the rounded display over 10.4').not.toHaveBeenCalled();
    await act(async () => {
      await userEvent.fill(x, '40');
      await userEvent.keyboard('{Enter}');
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]?.[1]).toMatchObject({ forward: expect.anything() });
    expect(host!.textContent).toContain('Paint');
    expect(page.getByRole('button', { exact: true, name: 'Apply' }).query()).toBeNull();
  });

  it('wraps rotation into a half turn and names a selected group instead of editing it', async () => {
    await mount(TransformPane, 'layer');
    const commit = vi.spyOn(engine!.layers, 'commitPrepared');
    const rotation = page.getByRole('spinbutton', { exact: true, name: 'Rotation' });
    await expect.element(rotation).toHaveValue('28.65');
    await act(async () => {
      await userEvent.fill(rotation, '270');
      await userEvent.keyboard('{Enter}');
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(commit.mock.calls[0]?.[1])).toContain(String(-Math.PI / 2));

    await act(() => root?.unmount());
    host?.remove();
    registry?.releaseEngine('p');
    await mount(TransformPane, 'group');
    expect(host!.textContent).toContain('Folder');
    expect(host!.textContent).toContain('Select a layer inside this group to transform.');
    await expect.element(page.getByRole('spinbutton', { exact: true, name: 'X' })).toBeDisabled();
  });

  it('scrubs a field from its label and commits the result once when the mouse button lifts', async () => {
    await mount(TransformPane, 'layer');
    // The scrubber locks the pointer once a real click has activated the page; the harness lock steals focus.
    vi.spyOn(Element.prototype, 'requestPointerLock').mockImplementation(() => Promise.resolve());
    const commit = vi.spyOn(engine!.layers, 'commitPrepared');
    const scrubber = host!.querySelector<HTMLElement>('[data-scope="number-input"][data-part="scrubber"]')!;
    const x = page.getByRole('spinbutton', { exact: true, name: 'X' });
    await act(() =>
      scrubber.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 100, clientY: 100 }))
    );
    for (let step = 1; step <= 5; step += 1) {
      await act(() =>
        document.dispatchEvent(
          new MouseEvent('mousemove', { bubbles: true, clientX: 100 + step * 4, clientY: 100, movementX: 4 })
        )
      );
    }
    await expect.element(x).toHaveValue('15');
    expect(commit).not.toHaveBeenCalled();
    await act(() =>
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 120, clientY: 100 }))
    );
    expect(commit).toHaveBeenCalledTimes(1);
  });
});

describe('Layer editor panes host', () => {
  it('keeps the collapsed strip reachable and expands from tab selection', async () => {
    paneHarnessLayout = { ...LAYER_EDITOR_PANE_DEFAULTS };
    await mount(LayerEditorPanesHarness);
    await act(async () => {
      await userEvent.click(page.getByRole('button', { exact: true, name: 'Collapse editor panes' }));
    });
    await settle();
    const propertiesTab = page.getByRole('tab', { exact: true, name: 'Properties' });
    await expect.element(propertiesTab).toHaveAttribute('aria-selected', 'true');
    expect((propertiesTab.element() as HTMLElement).tabIndex).toBe(0);
    expect(host!.querySelector('[role="tabpanel"]')).toBeNull();
    await act(async () => {
      await userEvent.click(propertiesTab);
    });
    await settle();
    expect(host!.querySelector('[role="tabpanel"]')).not.toBeNull();
  });

  it('collapses from the separator keyboard floor and hands focus to the expand button', async () => {
    paneHarnessLayout = { ...LAYER_EDITOR_PANE_DEFAULTS, sizePx: 140 };
    await mount(LayerEditorPanesHarness);
    const separator = host!.querySelector<HTMLElement>('[role="separator"]')!;
    await act(() => separator.focus());
    await act(() => separator.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' })));
    await settle();
    const expand = page.getByRole('button', { exact: true, name: 'Expand editor panes' });
    await expect.element(expand).toBeVisible();
    expect(document.activeElement).toBe(expand.element());
  });
});
