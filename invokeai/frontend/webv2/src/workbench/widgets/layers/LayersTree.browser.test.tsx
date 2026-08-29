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
  setLayerPanelFilter,
  useLayerPanelState,
} from '@workbench/layerPanelState';
import { createInitialWorkbenchState } from '@workbench/workbenchState';
import { createInstance } from 'i18next';
import { act, useCallback, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import { LAYER_ROW_HEIGHT_PX } from './layerPanelRows';
import { LayersTree, type LayersTreeEngine } from './LayersTree';
import { buildLayerStackRows } from './layerTreeRows';

vi.mock('./ControlLayerWarningIcon', () => ({ ControlLayerWarningIcon: () => null }));
vi.mock('./LayerThumbnail', () => ({ LayerThumbnail: () => <span data-testid="thumbnail" /> }));
vi.mock('./LayerStackHeader', () => ({
  LayerStackHeader: ({ stack }: { stack: string }) => <div data-testid="stack-header">{stack}</div>,
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

const Harness = ({ degraded = false, initialNodes }: { degraded?: boolean; initialNodes: CanvasNodeContract[] }) => {
  const [project, setProject] = useState<Project>(() => {
    const initial = { ...createInitialWorkbenchState().projects[0]!, id: PROJECT_ID };
    return applyCanvasProjectMutation(initial, {
      document: { ...createEmptyCanvasDocument(), selectedLayerId: null, stacks: stacksFrom(initialNodes) },
      type: 'replaceCanvasDocument',
    });
  });
  const document = project.canvas.document;
  const panel = useLayerPanelState(PROJECT_ID, document.selectedLayerId);
  const dispatch = useCallback((mutation: CanvasProjectMutation) => {
    setProject((current) => applyCanvasProjectMutation(current, mutation));
    return true;
  }, []);
  const engine = useMemo(
    () =>
      ({
        document: {
          model: () => createDocumentModel(document, { editRevision: 0, projectId: PROJECT_ID }),
        },
        exports: { hasExportableLayerContent: () => false },
        interaction: { get: () => false },
        layers: {
          commitPrepared: (_label: string, edit: PreparedDocumentEdit) => {
            dispatch(edit.forward);
            return { status: 'committed' as const };
          },
        },
        previews: { drawLayerThumbnail: () => false, requestLayerThumbnail: () => undefined },
        projectId: PROJECT_ID,
      }) as unknown as LayersTreeEngine,
    [dispatch, document]
  );
  const expanded = useMemo(() => new Set(panel.expandedGroupIds), [panel.expandedGroupIds]);
  const stacks = useMemo(
    () => buildLayerStackRows(document, expanded, panel.filter),
    [document, expanded, panel.filter]
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 320, width: 480 }}>
      <LayersTree
        degraded={degraded}
        dispatch={dispatch}
        document={document}
        editingLocked={false}
        engine={engine}
        panel={panel}
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

const renderTree = async (initialNodes: CanvasNodeContract[], degraded = false) => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(() => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <ChakraProvider value={system}>
          <Harness degraded={degraded} initialNodes={initialNodes} />
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

const treeitems = (): HTMLButtonElement[] => Array.from(host!.querySelectorAll<HTMLButtonElement>('[role="treeitem"]'));
const treeitem = (name: string): HTMLButtonElement =>
  host!.querySelector<HTMLButtonElement>(`[role="treeitem"][aria-label="Select ${name}"]`)!;
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

beforeEach(() => clearLayerPanelStates());

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
    expect(treeitems().length).toBeLessThanOrEqual(visible + 12 + 1);
    expect(treeitems().length).toBeGreaterThanOrEqual(visible);
    const tree = host!.querySelector<HTMLElement>('[role="tree"]')!;
    expect(tree.getAttribute('aria-multiselectable')).toBe('true');
    expect(getComputedStyle(tree).height).toBe(`${2000 * LAYER_ROW_HEIGHT_PX.comfortable + 28}px`);
  });

  it('commits only the rows a selection change touches', async () => {
    await renderTree(manyLayers(2000));
    await act(() => userEvent.click(treeitem('Layer 1')));
    const touched = new Set<string>();
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const row = (record.target as Element).closest?.('[data-layer-row-id]') as HTMLElement | null;
        if (row) {
          touched.add(row.dataset.layerRowId!);
        }
      }
    });
    observer.observe(host!.querySelector('[role="tree"]')!, { attributes: true, childList: true, subtree: true });
    await act(() => userEvent.click(treeitem('Layer 3')));
    observer.disconnect();
    expect(output('selected-layer')).toBe('l3');
    expect([...touched].sort()).toEqual(['l1', 'l3']);
  });

  it('keeps thumbnails and drag off in degraded mode', async () => {
    await renderTree(manyLayers(3), true);
    expect(host!.querySelectorAll('[data-testid="thumbnail"]')).toHaveLength(0);
    expect(treeitem('Layer 0').getAttribute('aria-roledescription')).toBeNull();
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

  it('exposes one tab stop and full tree semantics', async () => {
    await renderTree(nested());
    expect(treeitems().filter((item) => item.tabIndex === 0)).toHaveLength(1);
    const group = treeitem('Group');
    expect(group).toHaveAttribute('aria-level', '1');
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
    expect(treeitem('Inner')).toHaveAttribute('aria-level', '2');
    await act(() => userEvent.keyboard('{ArrowLeft}'));
    expect(document.activeElement).toBe(treeitem('Group'));
    await act(() => userEvent.keyboard('{End}'));
    expect(document.activeElement).toBe(treeitem('Bottom'));
    await act(() => userEvent.keyboard('{Home}'));
    expect(document.activeElement).toBe(treeitem('Top'));
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
    expect(treeitem('Third')).toHaveAttribute('aria-level', '2');
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
