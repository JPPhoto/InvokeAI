/* oxlint-disable react-perf/jsx-no-new-function-as-prop */
import type { CanvasNodeContract, PreparedDocumentEdit } from '@workbench/canvas-engine/api';
import type { CanvasProjectMutation } from '@workbench/canvasProjectMutations';

import { ChakraProvider } from '@chakra-ui/react';
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { system } from '@theme/system';
import { createDocumentModel } from '@workbench/canvas-engine/api';
import { groupContract, stacksFrom } from '@workbench/canvas-engine/document-model/documentFixtures.testStub';
import { createEmptyCanvasDocument } from '@workbench/canvasMigration';
import { createLayerPanelState, selectLayerInPanel } from '@workbench/layerPanelState';
import { createInstance } from 'i18next';
import { act, useCallback, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import { createEmptyPaintLayer } from './layerOps';
import { LayerRow, type LayerRowEngine } from './LayerRow';
import { buildLayerStackRows } from './layerTreeRows';

vi.mock('./ControlLayerWarningIcon', () => ({
  ControlLayerWarningIcon: () => null,
}));

vi.mock('@workbench/widgets/canvas/engineStoreHooks', () => ({
  useLayerThumbnailStatus: () => 'error',
  useLayerThumbnailVersion: () => 0,
}));

vi.mock('./LayerPropertiesPopover', async () => {
  const { createElement } = await import('react');
  const { createPortal } = await import('react-dom');
  return {
    LayerPropertiesPopover: () =>
      createPortal(createElement('textarea', { 'aria-label': 'Regional guidance prompt' }), document.body),
  };
});

vi.mock('./LayerContextMenu', () => ({
  CanvasLayerContextMenu: ({ target }: { target: { layerId: string } | null }) => (
    <output data-testid="layer-context-menu-target">{target?.layerId ?? 'none'}</output>
  ),
  LayerContextMenu: () => <button aria-label="Layer menu" type="button" />,
}));

vi.mock('./LayerGroupContextMenu', () => ({
  LayerGroupContextMenu: () => <button aria-label="Group menu" type="button" />,
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
              reorder: 'Reorder layer',
              select: 'Select {{name}}',
              toggleLock: 'Toggle lock',
              toggleVisibility: 'Toggle visibility',
            },
            groupSummary_one: '{{count}} layer',
            groupSummary_other: '{{count}} layers',
            types: { paint: 'Paint' },
          },
        },
      },
    },
  },
});

const INITIAL_NODES: CanvasNodeContract[] = [
  createEmptyPaintLayer('First layer', 'first'),
  createEmptyPaintLayer('Second layer', 'second'),
];
const requestLayerThumbnail = vi.fn();

const Harness = ({ initialNodes = INITIAL_NODES }: { initialNodes?: CanvasNodeContract[] }) => {
  const [nodes, setNodes] = useState(initialNodes);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [selection, setSelection] = useState(() => createLayerPanelState('test-project', null));
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const selectedLayerId = selection.primaryId;
  const document = useMemo(
    () => ({ ...createEmptyCanvasDocument(), stacks: stacksFrom(nodes), selectedLayerId }),
    [nodes, selectedLayerId]
  );
  const rows = useMemo(() => buildLayerStackRows(document, expanded).raster.rows, [document, expanded]);
  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const dispatch = useCallback((mutation: CanvasProjectMutation) => {
    if (mutation.type === 'setCanvasSelectedLayer') {
      setSelection(createLayerPanelState('test-project', mutation.id));
    } else if (mutation.type === 'updateCanvasLayer' && mutation.patch.isEnabled !== undefined) {
      setNodes((current) =>
        current.map((node) =>
          node.id === mutation.id ? { ...node, isEnabled: mutation.patch.isEnabled ?? node.isEnabled } : node
        )
      );
    }
  }, []);
  const handleSelect = useCallback(
    (id: string, modifiers: { additive: boolean; range: boolean }) => {
      setSelection((current) => selectLayerInPanel(current, id, rowIds, modifiers));
    },
    [rowIds]
  );
  const handleToggleExpanded = useCallback((groupId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);
  const engine = useMemo(
    () =>
      ({
        document: {
          model: () => createDocumentModel(document, { editRevision: 0, projectId: 'test-project' }),
        },
        layers: {
          commitPrepared: (_label: string, edit: PreparedDocumentEdit) => {
            dispatch(edit.forward);
            return { status: 'committed' as const };
          },
          commitStructural: (_label: string, mutation: CanvasProjectMutation) => {
            dispatch(mutation);
            return { status: 'committed' as const };
          },
        },
        previews: {
          drawLayerThumbnail: () => false,
          requestLayerThumbnail,
        },
        projectId: 'test-project',
      }) as unknown as LayerRowEngine,
    [dispatch, document]
  );
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) {
      return;
    }
    setNodes((current) => {
      const from = current.findIndex((node) => node.id === event.active.id);
      const to = current.findIndex((node) => node.id === event.over?.id);
      return from === -1 || to === -1 ? current : arrayMove(current, from, to);
    });
  }, []);

  return (
    <DndContext collisionDetection={closestCenter} sensors={sensors} onDragEnd={handleDragEnd}>
      <SortableContext items={rowIds} strategy={verticalListSortingStrategy}>
        {rows.map((row) => (
          <LayerRow
            key={row.id}
            dispatch={dispatch}
            drag={null}
            editingLocked={false}
            engine={engine}
            isPrimarySelected={selectedLayerId === row.id}
            isSelected={selection.selectedIds.includes(row.id)}
            row={row}
            onSelect={handleSelect}
            onToggleExpanded={handleToggleExpanded}
          />
        ))}
      </SortableContext>
      <output data-testid="selected-layer">{selectedLayerId ?? 'none'}</output>
      <output data-testid="selected-layers">{selection.selectedIds.join(',') || 'none'}</output>
      <output data-testid="layer-order">{nodes.map((node) => node.id).join(',')}</output>
      <output data-testid="row-order">{rowIds.join(',')}</output>
    </DndContext>
  );
};

let host: HTMLDivElement | null = null;
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const renderHarness = async (initialNodes?: CanvasNodeContract[]) => {
  host = document.createElement('div');
  host.style.width = '480px';
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
};
const rowOrder = (): string => host!.querySelector<HTMLOutputElement>('[data-testid="row-order"]')!.value;

const pointer = (type: string, target: EventTarget, clientX: number, clientY: number): void => {
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, button: 0, clientX, clientY, isPrimary: true, pointerId: 1 })
  );
};

const selectionButton = (name: string): HTMLButtonElement =>
  host!.querySelector<HTMLButtonElement>(`button[aria-label="Select ${name}"]`)!;

const selectedLayer = (): string => host!.querySelector<HTMLOutputElement>('[data-testid="selected-layer"]')!.value;
const selectedLayers = (): string => host!.querySelector<HTMLOutputElement>('[data-testid="selected-layers"]')!.value;
const layerOrder = (): string => host!.querySelector<HTMLOutputElement>('[data-testid="layer-order"]')!.value;

afterEach(async () => {
  await act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  vi.clearAllMocks();
});

describe('LayerRow accessibility', () => {
  it('keeps layer-row background feedback nearly immediate', async () => {
    await renderHarness();

    const row = selectionButton('First layer').parentElement;
    expect(row).not.toBeNull();
    const style = getComputedStyle(row!);

    expect(style.transitionProperty).toBe('background');
    expect(style.transitionDuration).toBe('0.04s');
  });

  it('keeps the sortable control free of interactive descendants', async () => {
    await renderHarness();

    const sortableControl = host!.querySelector<HTMLElement>('[aria-roledescription="sortable"]');
    expect(sortableControl).not.toBeNull();
    expect(
      sortableControl!.querySelector('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')
    ).toBeNull();
  });

  it('gives the compact visibility control a 24px touch target', async () => {
    await renderHarness();

    const visibility = host!.querySelector<HTMLButtonElement>('button[aria-label="Toggle visibility"]');
    expect(visibility).not.toBeNull();
    const rect = visibility!.getBoundingClientRect();
    expect(rect.width).toBeGreaterThanOrEqual(24);
    expect(rect.height).toBeGreaterThanOrEqual(24);
  });

  it('sits the visibility dot on the same centre line as the other row controls', async () => {
    // The dot lives in a wrapper Box that exists only to catch pointer events.
    // As a block box that wrapper laid the button out on a text baseline, so
    // descender space below it pushed the dot 3px above its siblings.
    await renderHarness();

    const centreY = (selector: string): number => {
      const element = host!.querySelector<HTMLElement>(selector);
      expect(element).not.toBeNull();
      const rect = element!.getBoundingClientRect();
      return rect.top + rect.height / 2;
    };

    const visibility = centreY('button[aria-label="Toggle visibility"]');
    const lock = centreY('button[aria-label="Toggle lock"]');

    expect(visibility).toBeCloseTo(lock, 1);
  });

  it('selects a layer with a pointer without requiring the drag handle', async () => {
    await renderHarness();

    await act(() => userEvent.click(selectionButton('First layer')));

    expect(selectedLayer()).toBe('first');
  });

  it('adds and removes rows with Ctrl/Cmd-click while marking the latest addition primary', async () => {
    await renderHarness();
    await act(() => userEvent.click(selectionButton('First layer')));

    await act(() =>
      selectionButton('Second layer').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    );
    expect(selectedLayers()).toBe('first,second');
    expect(selectedLayer()).toBe('second');
    expect(selectionButton('First layer')).toHaveAttribute('aria-selected', 'true');
    expect(selectionButton('First layer')).not.toHaveAttribute('aria-current');
    expect(selectionButton('Second layer')).toHaveAttribute('aria-current', 'true');
    expect(selectionButton('Second layer')).toHaveAttribute('data-primary', 'true');

    await act(() =>
      selectionButton('First layer').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
    );
    expect(selectedLayers()).toBe('second');
    expect(selectedLayer()).toBe('second');
  });

  it('selects a visible range with Shift-click', async () => {
    await renderHarness();
    await act(() => userEvent.click(selectionButton('First layer')));

    await act(() =>
      selectionButton('Second layer').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    );

    expect(selectedLayers()).toBe('first,second');
    expect(selectedLayer()).toBe('second');
  });

  it.each([
    ['Enter', '{Enter}'],
    ['Space', ' '],
  ])('selects a layer with %s on the selection control', async (_label, key) => {
    await renderHarness();
    selectionButton('Second layer').focus();

    await act(() => userEvent.keyboard(key));

    expect(selectedLayer()).toBe('second');
    expect(layerOrder()).toBe('first,second');
  });

  it('keeps visibility toggling isolated from row selection', async () => {
    await renderHarness();
    const visibility = host!.querySelectorAll<HTMLButtonElement>('button[aria-label="Toggle visibility"]')[0]!;

    await act(() => userEvent.click(visibility));

    expect(visibility).toHaveAttribute('aria-pressed', 'false');
    expect(selectedLayer()).toBe('none');
  });

  it('preserves the native context menu inside portalled layer settings', async () => {
    await renderHarness();
    const prompt = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Regional guidance prompt"]');
    expect(prompt).not.toBeNull();
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 30,
      clientY: 40,
    });

    await act(() => prompt!.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(false);
    expect(selectedLayer()).toBe('none');
  });

  it('still opens the layer context menu from the row itself', async () => {
    await renderHarness();
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 30,
      clientY: 40,
    });

    await act(() => selectionButton('First layer').dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(selectedLayer()).toBe('first');
    expect(
      Array.from(host!.querySelectorAll<HTMLOutputElement>('[data-testid="layer-context-menu-target"]')).some(
        (output) => output.value === 'first'
      )
    ).toBe(true);
  });

  it('keeps thumbnail retry focus, click, and pointer movement isolated from row selection and sorting', async () => {
    await renderHarness();
    const retry = host!.querySelector<HTMLButtonElement>('button[aria-label="Retry thumbnail for First layer"]')!;
    const second = selectionButton('Second layer');
    retry.focus();
    expect(document.activeElement).toBe(retry);

    await act(() => userEvent.click(retry));
    expect(requestLayerThumbnail).toHaveBeenCalledWith('first');
    expect(selectedLayer()).toBe('none');

    const retryRect = retry.getBoundingClientRect();
    const secondRect = second.getBoundingClientRect();
    const startX = retryRect.left + retryRect.width / 2;
    const startY = retryRect.top + retryRect.height / 2;
    const endX = secondRect.left + secondRect.width / 2;
    const endY = secondRect.top + secondRect.height / 2;

    await act(() => pointer('pointerdown', retry, startX, startY));
    await act(() => pointer('pointermove', retry.ownerDocument, startX + 8, startY));
    await act(() => pointer('pointermove', retry.ownerDocument, endX, endY));
    await act(() => pointer('pointerup', retry.ownerDocument, endX, endY));

    expect(layerOrder()).toBe('first,second');
    expect(selectedLayer()).toBe('none');
  });

  it('preserves whole-row pointer sorting outside the dedicated handle', async () => {
    await renderHarness();
    const first = selectionButton('First layer');
    const second = selectionButton('Second layer');
    const firstRect = first.getBoundingClientRect();
    const secondRect = second.getBoundingClientRect();
    const startX = firstRect.left + firstRect.width / 2;
    const startY = firstRect.top + firstRect.height / 2;
    const endX = secondRect.left + secondRect.width / 2;
    const endY = secondRect.top + secondRect.height / 2;

    await act(() => pointer('pointerdown', first, startX, startY));
    await act(() => pointer('pointermove', first.ownerDocument, startX + 8, startY));
    await act(() => pointer('pointermove', first.ownerDocument, endX, endY));
    await act(() => pointer('pointerup', first.ownerDocument, endX, endY));

    expect(layerOrder()).toBe('second,first');
  });

  it('expands and collapses a group from its chevron and arrow keys, indenting its children', async () => {
    await renderHarness([
      groupContract('g', [createEmptyPaintLayer('Inner layer', 'inner')], { name: 'Group' }),
      createEmptyPaintLayer('Outer layer', 'outer'),
    ]);
    expect(rowOrder()).toBe('g,outer');
    expect(selectionButton('Group')).toHaveAttribute('aria-expanded', 'false');

    await act(() => userEvent.click(host!.querySelector<HTMLButtonElement>('button[aria-label="Expand group"]')!));
    expect(rowOrder()).toBe('g,inner,outer');
    expect(selectionButton('Group')).toHaveAttribute('aria-expanded', 'true');
    expect(selectionButton('Inner layer')).toHaveAttribute('aria-level', '2');
    expect(getComputedStyle(selectionButton('Inner layer').parentElement!).paddingLeft).toBe('16px');

    selectionButton('Group').focus();
    await act(() => userEvent.keyboard('{ArrowLeft}'));
    expect(rowOrder()).toBe('g,outer');
  });

  it('reports a lock inherited from a group on the child row', async () => {
    await renderHarness([
      groupContract('g', [createEmptyPaintLayer('Inner layer', 'inner')], { isLocked: true, name: 'Group' }),
    ]);
    await act(() => userEvent.click(host!.querySelector<HTMLButtonElement>('button[aria-label="Expand group"]')!));

    const locks = host!.querySelectorAll<HTMLButtonElement>('button[aria-label="Toggle lock"]');
    expect(locks).toHaveLength(2);
    expect(locks[1]!.querySelector('svg.lucide-lock')).not.toBeNull();
  });
});
