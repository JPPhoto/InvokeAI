/* oxlint-disable react-perf/jsx-no-new-function-as-prop */
import type { CanvasNodeContract, PreparedDocumentEdit } from '@workbench/canvas-engine/api';
import type { CanvasProjectMutation } from '@workbench/canvasProjectMutations';
import type { Project } from '@workbench/projectContracts';

import { ChakraProvider } from '@chakra-ui/react';
import { system } from '@theme/system';
import { createDocumentModel, getDocumentLeaves } from '@workbench/canvas-engine/api';
import {
  groupContract,
  layerContract,
  stacksFrom,
} from '@workbench/canvas-engine/document-model/documentFixtures.testStub';
import { createEmptyCanvasDocument } from '@workbench/canvasMigration';
import { applyCanvasProjectMutation } from '@workbench/canvasProjectMutations';
import {
  clearLayerPanelStates,
  readLayerPanelState,
  reconcileLayerPanelStates,
  setLayerPanelFilter,
  toggleLayerStackCollapsed,
  useLayerPanelState,
} from '@workbench/layerPanelState';
import { createInitialWorkbenchState } from '@workbench/workbenchState';
import { createInstance } from 'i18next';
import { act, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import { getLayerRowCommits, resetLayerRowCommits } from './layerPanelDiagnostics';
import { LAYER_PANEL_DEGRADE_THRESHOLD, LAYER_ROW_HEIGHT_PX } from './layerPanelRows';
import { LayersTree, type LayersTreeEngine } from './LayersTree';
import { buildLayerStackRows } from './layerTreeRows';

vi.mock('./ControlLayerWarningIcon', () => ({ ControlLayerWarningIcon: () => null }));
vi.mock('./LayerThumbnail', () => ({ LayerThumbnail: () => <span data-testid="thumbnail" /> }));
vi.mock('./LayerStackHeader', () => ({
  LayerStackHeader: ({
    commands,
    focused,
    pinned,
    rowKey,
    stack,
  }: {
    commands: { focus(key: string): void; keyDown(key: string, event: React.KeyboardEvent<HTMLElement>): void };
    focused: boolean;
    pinned?: boolean;
    rowKey: string;
    stack: string;
  }) => (
    <div
      aria-label={stack}
      aria-level={1}
      data-layer-row-id={pinned ? undefined : rowKey}
      aria-hidden={pinned || undefined}
      data-testid="stack-header"
      role="treeitem"
      tabIndex={pinned ? undefined : focused ? 0 : -1}
      onFocus={() => commands.focus(rowKey)}
      onKeyDown={(event) => commands.keyDown(rowKey, event)}
    >
      {stack}
    </div>
  ),
}));
vi.mock('./LayerSurfaceHost', () => ({
  LayerSurfaceHost: ({ surface }: { surface: { kind: string; id: string } | null }) => (
    <output data-testid="surface">{surface ? `${surface.kind}:${surface.id}` : 'none'}</output>
  ),
}));

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  fallbackLng: 'en',
  initAsync: false,
  lng: 'en',
  resources: {
    en: {
      translation: {
        widgets: {
          layers: {
            actions: {
              collapseGroup: 'Collapse group',
              expandGroup: 'Expand group',
              groupLocked: 'Locked by a group',
              indent: 'Move into the group above',
              outdent: 'Move out of the group',
              rename: 'Rename',
              reorder: 'Reorder layer',
              select: 'Select {{name}}',
              toggleLock: 'Toggle lock',
              toggleVisibility: 'Toggle visibility',
            },
            groupSummary_one: '{{count}} layer',
            groupSummary_other: '{{count}} layers',
            groups: { raster: 'Raster Layers' },
            options: 'Layer options',
            properties: 'Layer properties',
            tree: 'Layer tree',
            types: { paint: 'Paint' },
          },
        },
      },
    },
  },
});

const PROJECT_ID = 'test-project';
const HIDDEN = { display: 'none' } as const;
const paint = (id: string, name = id) => layerContract(id, 'raster', { name });
const manyLayers = (count: number): CanvasNodeContract[] =>
  Array.from({ length: count }, (_, index) => paint(`l${index}`, `Layer ${index}`));

let dispatchExternal: (mutation: CanvasProjectMutation) => void = () => undefined;
const thumbnailRequests = vi.fn();
const refusalChecks = vi.fn();

const Harness = ({ initialNodes }: { initialNodes: CanvasNodeContract[] }) => {
  const [project, setProject] = useState<Project>(() => {
    const initial = { ...createInitialWorkbenchState().projects[0]!, id: PROJECT_ID };
    return applyCanvasProjectMutation(initial, {
      document: { ...createEmptyCanvasDocument(), selectedLayerId: null, stacks: stacksFrom(initialNodes) },
      type: 'replaceCanvasDocument',
    });
  });
  const document = project.canvas.document;
  // Production reconciles the panel against every document change before the panel reads it.
  useLayoutEffect(() => reconcileLayerPanelStates([project]), [project]);
  const panel = useLayerPanelState(PROJECT_ID, document.selectedLayerId);
  const dispatch = useCallback((mutation: CanvasProjectMutation) => {
    setProject((current) => applyCanvasProjectMutation(current, mutation));
    return true;
  }, []);
  useEffect(() => {
    dispatchExternal = dispatch;
  }, [dispatch]);
  // The real engine handle is stable across document changes; the harness reads the document through a ref.
  const documentRef = useRef(document);
  useEffect(() => {
    documentRef.current = document;
  }, [document]);
  const engine = useMemo(
    () =>
      ({
        document: {
          model: () => {
            const model = createDocumentModel(documentRef.current, { editRevision: 0, projectId: PROJECT_ID });
            return {
              ...model,
              refusalFor: (command: Parameters<typeof model.refusalFor>[0]) => {
                refusalChecks(command);
                return model.refusalFor(command);
              },
            };
          },
        },
        exports: { hasExportableLayerContent: () => false },
        interaction: { get: () => false },
        layers: {
          commitPrepared: (_label: string, edit: PreparedDocumentEdit) => {
            dispatch(edit.forward);
            return { status: 'committed' as const };
          },
        },
        previews: { drawLayerThumbnail: () => false, requestLayerThumbnail: thumbnailRequests },
        projectId: PROJECT_ID,
      }) as unknown as LayersTreeEngine,
    [dispatch]
  );
  const expanded = useMemo(() => new Set(panel.expandedGroupIds), [panel.expandedGroupIds]);
  const stacks = useMemo(
    () => buildLayerStackRows(document.stacks, expanded, panel.filter),
    [document, expanded, panel.filter]
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 320, width: 480 }}>
      <LayersTree
        degraded={initialNodes.length > LAYER_PANEL_DEGRADE_THRESHOLD}
        dispatch={dispatch}
        document={document}
        editingLocked={false}
        engine={engine}
        panel={panel}
        onRevealProperties={() => undefined}
        projectId={PROJECT_ID}
        stacks={stacks}
      />
      <output data-testid="selected-layer" style={HIDDEN}>
        {document.selectedLayerId ?? 'none'}
      </output>
      <output data-testid="selected-layers" style={HIDDEN}>
        {panel.selectedIds.join(',') || 'none'}
      </output>
      <output data-testid="layer-order" style={HIDDEN}>
        {getDocumentLeaves(document)
          .map((layer) => layer.id)
          .join(',')}
      </output>
    </div>
  );
};

let host: HTMLDivElement | null = null;
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const renderTree = async (initialNodes: CanvasNodeContract[]) => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(() => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <ChakraProvider value={system}>
          <Harness initialNodes={initialNodes} />
        </ChakraProvider>
      </I18nextProvider>
    );
  });
  // The virtualizer sizes its window from a ResizeObserver report, which lands after the first paint.
  await settle();
};

const settle = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );

const treeitems = (): HTMLElement[] => Array.from(host!.querySelectorAll<HTMLElement>('[role="treeitem"]'));
const treeitem = (name: string): HTMLElement =>
  host!.querySelector<HTMLElement>(`[role="treeitem"][aria-label="${name}"]`)!;
/** Every element inside the tree a Tab press could land on. */
const tabStops = (): HTMLElement[] =>
  Array.from(
    host!.querySelectorAll<HTMLElement>('[role="tree"] button, [role="tree"] input, [role="tree"] [tabindex]')
  ).filter((element) => element.tabIndex >= 0);
const output = (id: string): string => host!.querySelector<HTMLOutputElement>(`[data-testid="${id}"]`)!.value;
const pointer = (type: string, target: EventTarget, clientX: number, clientY: number): void => {
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, button: 0, clientX, clientY, isPrimary: true, pointerId: 1 })
  );
};
const centre = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

beforeEach(() => {
  clearLayerPanelStates();
  resetLayerRowCommits();
  thumbnailRequests.mockClear();
  refusalChecks.mockClear();
});

afterEach(async () => {
  await act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  vi.clearAllMocks();
});

describe('LayersTree virtualization', () => {
  it('mounts only the rows near the viewport of a 2,000-layer document and keeps the tree height exact', async () => {
    await renderTree(manyLayers(2000));
    const visible = Math.ceil(320 / LAYER_ROW_HEIGHT_PX.comfortable);
    expect(treeitems().length).toBeLessThanOrEqual(visible + 12 + 2);
    expect(treeitems().length).toBeGreaterThanOrEqual(visible);
    // Thumbnails are asked for once per mounted leaf and never again for the rest of the list.
    expect(thumbnailRequests.mock.calls.length).toBeLessThanOrEqual(treeitems().length);
    const tree = host!.querySelector<HTMLElement>('[role="tree"]')!;
    expect(tree.getAttribute('aria-multiselectable')).toBe('true');
    expect(getComputedStyle(tree).height).toBe(`${2000 * LAYER_ROW_HEIGHT_PX.comfortable + 28}px`);
  });

  it('commits only the rows a selection change touches, and nothing on scroll', async () => {
    await renderTree(manyLayers(2000));
    await act(() => userEvent.click(treeitem('Layer 1')));
    resetLayerRowCommits();
    thumbnailRequests.mockClear();
    await act(() => userEvent.click(treeitem('Layer 3')));
    expect(output('selected-layer')).toBe('l3');
    expect(Object.keys(getLayerRowCommits()).sort()).toEqual(['l1', 'l3']);
    expect(thumbnailRequests).not.toHaveBeenCalled();

    resetLayerRowCommits();
    const scroller = host!.querySelector<HTMLElement>('[role="tree"]')!.parentElement!;
    await act(() => {
      scroller.scrollTop = 7;
      scroller.dispatchEvent(new Event('scroll'));
    });
    await settle();
    expect(getLayerRowCommits()).toEqual({});
  });

  it('degrades a document above the threshold: no thumbnails, no drag, every command intact', async () => {
    await renderTree(manyLayers(LAYER_PANEL_DEGRADE_THRESHOLD + 1));
    expect(host!.querySelectorAll('[data-testid="thumbnail"]')).toHaveLength(0);
    expect(thumbnailRequests).not.toHaveBeenCalled();
    const first = host!.querySelector<HTMLElement>('[data-layer-row-id="l0"]')!;
    const second = host!.querySelector<HTMLElement>('[data-layer-row-id="l1"]')!;
    const start = centre(first);
    const end = centre(second);
    await act(() => pointer('pointerdown', first, start.x, start.y));
    await act(() => pointer('pointermove', document, start.x + 8, start.y));
    await act(() => pointer('pointermove', document, end.x, end.y + 12));
    await act(() => pointer('pointerup', document, end.x, end.y + 12));
    expect(output('layer-order').startsWith('l0,l1,l2')).toBe(true);
    treeitem('Layer 0').focus();
    await act(() => userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}'));
    expect(output('layer-order').startsWith('l1,l0,l2')).toBe(true);
  });
});

describe('LayersTree keyboard and accessibility', () => {
  const nested = (): CanvasNodeContract[] => [
    paint('top', 'Top'),
    groupContract(
      'g',
      [paint('inner', 'Inner'), groupContract('h', [paint('deep', 'Deep')], { name: 'Inner group' })],
      {
        isLocked: true,
        name: 'Group',
      }
    ),
    paint('bottom', 'Bottom'),
  ];

  it('exposes one tab stop across every control and full tree semantics', async () => {
    await renderTree(nested());
    expect(tabStops()).toHaveLength(1);
    expect(host!.querySelectorAll('[role="tree"] > *')).toHaveLength(
      host!.querySelectorAll('[role="tree"] > [role="presentation"]').length
    );
    const group = treeitem('Group');
    expect(group).toHaveAttribute('aria-level', '2');
    expect(group).toHaveAttribute('aria-posinset', '2');
    expect(group).toHaveAttribute('aria-setsize', '3');
    expect(group).toHaveAttribute('aria-expanded', 'false');
    expect(group).toHaveAttribute('aria-selected', 'false');
  });

  it('walks rows with the arrow keys, opens and enters groups, climbs to the parent, and jumps with End', async () => {
    await renderTree(nested());
    treeitem('Top').focus();
    await act(() => userEvent.keyboard('{ArrowDown}'));
    expect(document.activeElement).toBe(treeitem('Group'));
    expect(treeitem('Group').tabIndex).toBe(0);
    expect(treeitem('Top').tabIndex).toBe(-1);
    await act(() => userEvent.keyboard('{ArrowRight}'));
    expect(treeitem('Group')).toHaveAttribute('aria-expanded', 'true');
    await act(() => userEvent.keyboard('{ArrowRight}'));
    expect(document.activeElement).toBe(treeitem('Inner'));
    expect(treeitem('Inner')).toHaveAttribute('aria-level', '3');
    await act(() => userEvent.keyboard('{ArrowLeft}'));
    expect(document.activeElement).toBe(treeitem('Group'));
    await act(() => userEvent.keyboard('{End}'));
    expect(document.activeElement).toBe(treeitem('Bottom'));
    await act(() => userEvent.keyboard('{Home}'));
    expect(document.activeElement).toBe(treeitem('raster'));
    await act(() => userEvent.keyboard('{ArrowLeft}'));
    expect(host!.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
    await act(() => userEvent.keyboard('{ArrowRight}{ArrowRight}'));
    expect(document.activeElement).toBe(treeitem('Top'));
    await act(() => userEvent.keyboard('{Shift>}{F10}{/Shift}'));
    expect(output('surface')).toBe('menu:top');
  });

  it('keeps the focused row mounted and focused while scrolled far away', async () => {
    await renderTree(manyLayers(2000));
    treeitem('Layer 0').focus();
    await act(() => userEvent.keyboard('{End}'));
    await settle();
    expect(document.activeElement).toBe(treeitem('Layer 1999'));
    const scroller = host!.querySelector<HTMLElement>('[role="tree"]')!.parentElement!;
    await act(() => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
    });
    await settle();
    expect(treeitem('Layer 1999')).not.toBeNull();
    expect(treeitem('Layer 1999').tabIndex).toBe(0);
  });

  it('reports the inherited lock on rows under a locked group', async () => {
    await renderTree(nested());
    await act(() => userEvent.click(host!.querySelector<HTMLButtonElement>('button[aria-label="Expand group"]')!));
    const innerRow = host!.querySelector<HTMLElement>('[data-layer-row-id="inner"]')!;
    const lock = innerRow.querySelector<HTMLButtonElement>('button[aria-label="Toggle lock"]')!;
    expect(lock.disabled).toBe(true);
    expect(lock.querySelector('svg.lucide-lock')).not.toBeNull();
  });
});

describe('LayersTree selection, surfaces and structure', () => {
  const trio = (): CanvasNodeContract[] => [
    paint('first', 'First'),
    paint('second', 'Second'),
    paint('third', 'Third'),
  ];

  it('selects with click, toggles with Ctrl, ranges with Shift', async () => {
    await renderTree(trio());
    await act(() => userEvent.click(treeitem('First')));
    expect(output('selected-layer')).toBe('first');
    await act(() => treeitem('Third').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
    expect(output('selected-layers')).toBe('first,third');
    expect(treeitem('Third')).toHaveAttribute('aria-current', 'true');
    await act(() => treeitem('First').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect(output('selected-layers')).toBe('first,second,third');
  });

  it('keeps the visibility dot isolated from row selection', async () => {
    await renderTree(trio());
    const dot = host!.querySelector<HTMLButtonElement>(
      '[data-layer-row-id="first"] button[aria-label="Toggle visibility"]'
    )!;
    await act(() => userEvent.click(dot));
    expect(dot).toHaveAttribute('aria-pressed', 'false');
    expect(output('selected-layer')).toBe('none');
  });

  it('routes the row menu and right-click to the panel surface host by id', async () => {
    await renderTree(trio());
    await act(() =>
      userEvent.click(
        host!.querySelector<HTMLButtonElement>('[data-layer-row-id="second"] button[aria-label="Layer options"]')!
      )
    );
    expect(output('surface')).toBe('menu:second');
    await act(() =>
      treeitem('Third').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
      )
    );
    expect(output('surface')).toBe('menu:third');
    expect(output('selected-layer')).toBe('third');
  });

  it('reveals a primary that changed outside the panel once, even inside a collapsed stack', async () => {
    await renderTree([layerContract('c1', 'control', { name: 'Control' }), ...manyLayers(2000)]);
    const scroller = host!.querySelector<HTMLElement>('[role="tree"]')!.parentElement!;
    expect(scroller.scrollTop).toBe(0);
    await act(() => dispatchExternal({ id: 'l1500', type: 'setCanvasSelectedLayer' }));
    await settle();
    expect(scroller.scrollTop).toBeGreaterThan(1000 * LAYER_ROW_HEIGHT_PX.comfortable);
    expect(treeitem('Layer 1500')).not.toBeNull();

    // Later list changes leave the scroll position alone.
    await act(() => toggleLayerStackCollapsed(PROJECT_ID, 'l1500', 'control'));
    scroller.scrollTop = 0;
    await act(() => toggleLayerStackCollapsed(PROJECT_ID, 'l1500', 'control'));
    await settle();
    expect(scroller.scrollTop).toBe(0);

    // A panel selection reveals nothing, but a later external change back to it does.
    scroller.scrollTop = 1500 * LAYER_ROW_HEIGHT_PX.comfortable;
    await settle();
    await act(() => userEvent.click(treeitem('Layer 1501')));
    const outside = document.createElement('input');
    document.body.append(outside);
    outside.focus();
    scroller.scrollTop = 0;
    await act(() => dispatchExternal({ id: 'l1500', type: 'setCanvasSelectedLayer' }));
    await settle();
    scroller.scrollTop = 0;
    await act(() => dispatchExternal({ id: 'l1501', type: 'setCanvasSelectedLayer' }));
    await settle();
    expect(scroller.scrollTop).toBeGreaterThan(1000 * LAYER_ROW_HEIGHT_PX.comfortable);
    outside.remove();

    // A primary inside a collapsed stack opens the stack and lands in view.
    await act(() => toggleLayerStackCollapsed(PROJECT_ID, 'l1500', 'control'));
    await act(() => dispatchExternal({ id: 'c1', type: 'setCanvasSelectedLayer' }));
    await settle();
    expect(readLayerPanelState(PROJECT_ID, 'c1').collapsedStacks).toEqual([]);
    expect(treeitem('Control')).not.toBeNull();
    expect(scroller.scrollTop).toBe(0);
  });

  it('scrolls the list while a drag rests in the edge band and asks the model once per target', async () => {
    await renderTree(manyLayers(200));
    const scroller = host!.querySelector<HTMLElement>('[role="tree"]')!.parentElement!;
    const first = host!.querySelector<HTMLElement>('[data-layer-row-id="l0"]')!;
    const start = centre(first);
    const rect = scroller.getBoundingClientRect();
    await act(() => pointer('pointerdown', first, start.x, start.y));
    await act(() => pointer('pointermove', document, start.x + 8, start.y));
    await act(() => pointer('pointermove', document, start.x, rect.bottom - 4));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 120);
    });
    const scrolled = scroller.scrollTop;
    expect(scrolled).toBeGreaterThan(0);
    await act(() => pointer('pointermove', document, start.x, rect.top + rect.height / 2));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 60);
    });
    expect(scroller.scrollTop).toBe(scrolled);
    const checks = refusalChecks.mock.calls.length;
    await act(() => pointer('pointerup', document, start.x, rect.top + rect.height / 2));
    expect(checks).toBeLessThanOrEqual(6);
  });

  it('reorders with a pointer drag and reparents from the keyboard', async () => {
    await renderTree([
      paint('first', 'First'),
      groupContract('g', [paint('inner', 'Inner')], { name: 'Group' }),
      paint('third', 'Third'),
    ]);
    const first = host!.querySelector<HTMLElement>('[data-layer-row-id="first"]')!;
    const third = host!.querySelector<HTMLElement>('[data-layer-row-id="third"]')!;
    const start = centre(first);
    const end = centre(third);
    await act(() => pointer('pointerdown', first, start.x, start.y));
    await act(() => pointer('pointermove', document, start.x + 8, start.y));
    await act(() => pointer('pointermove', document, end.x, end.y + 12));
    await act(() => pointer('pointerup', document, end.x, end.y + 12));
    expect(output('layer-order')).toBe('inner,third,first');

    treeitem('Third').focus();
    await act(() => userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}'));
    expect(output('layer-order')).toBe('inner,third,first');
    expect(readLayerPanelState(PROJECT_ID, null).expandedGroupIds).toContain('g');
    expect(treeitem('Third')).toHaveAttribute('aria-level', '3');
  });
});

describe('LayersTree list changes', () => {
  it('survives the list shrinking under the virtual window and repairs focus onto the tab stop', async () => {
    await renderTree(manyLayers(50));
    treeitem('Layer 0').focus();
    await act(() => userEvent.keyboard('{End}'));
    await settle();
    expect(document.activeElement).toBe(treeitem('Layer 49'));
    await act(() => {
      host!.querySelector<HTMLElement>('[role="tree"]')!.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await act(() => setLayerPanelFilter(PROJECT_ID, readLayerPanelState(PROJECT_ID, null).primaryId, 'Layer 1'));
    await settle();
    expect(treeitems().length).toBeGreaterThan(0);
    expect(treeitems().filter((item) => item.tabIndex === 0)).toHaveLength(1);
    expect(host!.contains(document.activeElement)).toBe(true);
    await act(() => setLayerPanelFilter(PROJECT_ID, readLayerPanelState(PROJECT_ID, null).primaryId, ''));
    await settle();
    expect(treeitems().length).toBeGreaterThan(8);
  });

  it('keeps the focused node and its rename draft when rows above it come and go', async () => {
    await renderTree([layerContract('c1', 'control', { name: 'Control' }), ...manyLayers(30)]);
    const row = treeitem('Layer 3');
    row.focus();
    await act(() => userEvent.keyboard('{F2}'));
    const input = host!.querySelector<HTMLInputElement>('input[aria-label="Rename"]')!;
    await act(() => userEvent.keyboard('abc'));
    await act(() => toggleLayerStackCollapsed(PROJECT_ID, readLayerPanelState(PROJECT_ID, null).primaryId, 'control'));
    await settle();
    expect(host!.querySelector<HTMLInputElement>('input[aria-label="Rename"]')).toBe(input);
    expect(input.value).toBe('abc');
    await act(() => userEvent.keyboard('{Escape}'));
    expect(treeitem('Layer 3')).toBe(row);
    expect(document.activeElement).toBe(row);
    await act(() => toggleLayerStackCollapsed(PROJECT_ID, readLayerPanelState(PROJECT_ID, null).primaryId, 'control'));
    await settle();
    expect(document.activeElement).toBe(treeitem('Layer 3'));
    expect(treeitem('Control')).not.toBeNull();
  });

  it('keeps the tree item focused when one of its controls is clicked, and lets a rename blur follow a click', async () => {
    await renderTree(manyLayers(3));
    await act(() => userEvent.click(treeitem('Layer 1').querySelector('button[aria-label="Toggle lock"]')!));
    expect(document.activeElement).toBe(treeitem('Layer 1'));
    expect(tabStops()).toEqual([treeitem('Layer 1')]);
    await act(() => userEvent.keyboard('{F2}'));
    await act(() => userEvent.keyboard('New'));
    await act(() => userEvent.click(treeitem('Layer 2')));
    expect(treeitem('New')).not.toBeNull();
    expect(document.activeElement).toBe(treeitem('Layer 2'));
    expect(output('selected-layer')).toBe('l2');
  });

  it('carries the selection with a keyboard move', async () => {
    await renderTree(manyLayers(3));
    await act(() => userEvent.click(treeitem('Layer 0')));
    await act(() => userEvent.click(treeitem('Layer 1'), { modifiers: ['Shift'] }));
    expect(output('selected-layers')).toBe('l0,l1');
    treeitem('Layer 0').focus();
    await act(() => userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}'));
    expect(output('layer-order')).toBe('l2,l0,l1');
  });

  it('leaves a locked group closed when an indent into it is refused, and ignores an empty move', async () => {
    await renderTree([
      groupContract('g', [paint('inner', 'Inner')], { isLocked: true, name: 'Group' }),
      paint('bottom', 'Bottom'),
    ]);
    treeitem('Bottom').focus();
    await act(() => userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}'));
    expect(output('layer-order')).toBe('inner,bottom');
    expect(readLayerPanelState(PROJECT_ID, null).expandedGroupIds).toEqual([]);
    await act(() => userEvent.keyboard('{ArrowUp}{ArrowRight}{ArrowDown}'));
    expect(document.activeElement).toBe(treeitem('Inner'));
    await act(() => userEvent.click(treeitem('Group')));
    await act(() => userEvent.click(treeitem('Inner'), { modifiers: ['Control'] }));
    treeitem('Inner').focus();
    await act(() => userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}'));
    expect(output('layer-order')).toBe('inner,bottom');
  });

  it('renames from the keyboard, reseeds the draft each time, and hands focus back to the row', async () => {
    await renderTree(manyLayers(3));
    treeitem('Layer 1').focus();
    await act(() => userEvent.keyboard('{F2}'));
    const input = host!.querySelector<HTMLInputElement>('input[aria-label="Rename"]')!;
    expect(input.value).toBe('Layer 1');
    await act(() => userEvent.keyboard('abc{Escape}'));
    expect(document.activeElement).toBe(treeitem('Layer 1'));
    await act(() => userEvent.keyboard('{F2}'));
    expect(host!.querySelector<HTMLInputElement>('input[aria-label="Rename"]')!.value).toBe('Layer 1');
    await act(() => userEvent.keyboard('Renamed{Enter}'));
    expect(treeitem('Renamed')).not.toBeNull();
    expect(document.activeElement).toBe(treeitem('Renamed'));
  });
});
