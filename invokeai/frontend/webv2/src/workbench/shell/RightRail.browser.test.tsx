/* oxlint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-array-as-prop */
import type { RightRailDock } from '@workbench/layoutContracts';
import type { WorkbenchInternalStore } from '@workbench/workbenchStore';

import { ChakraProvider } from '@chakra-ui/react';
import { DndContext } from '@dnd-kit/core';
import { system } from '@theme/system';
import { FocusRegionProvider } from '@workbench/focusRegions';
import { RIGHT_RAIL_DOCKS } from '@workbench/layoutContracts';
import { createWorkbenchStore } from '@workbench/workbenchStore';
import { createInstance } from 'i18next';
import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

const storeRef = vi.hoisted(() => ({ current: null as WorkbenchInternalStore | null }));

vi.mock('@workbench/WorkbenchContext', () => ({
  shallowEqual: Object.is,
  useActiveProjectId: () => {
    const store = storeRef.current!;
    return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).activeProject.id;
  },
  useActiveProjectSelector: (selector: (project: never) => unknown) => {
    const store = storeRef.current!;
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    return selector(snapshot.activeProject as never);
  },
  useWorkbenchCommands: () => storeRef.current!.commands,
}));
vi.mock('./Panels', () => ({
  WidgetPanelSlot: ({ instanceId, region }: { instanceId: string; region: string }) => (
    <div data-dock-body={region} data-instance={instanceId} style={{ height: '100%' }} />
  ),
}));
vi.mock('@workbench/widget-frame', async () => {
  const frames = await import('@workbench/widget-frame/WidgetFrames');
  const strip = await import('@workbench/widget-frame/WidgetStrip');
  const menu = await import('@workbench/widget-frame/WidgetInstanceContextMenu');

  return {
    WidgetChromeSlotById: ({ instanceId }: { instanceId: string }) => <span data-chrome-actions={instanceId} />,
    WidgetInstanceContextMenu: menu.WidgetInstanceContextMenu,
    WidgetPanelFrame: frames.WidgetPanelFrame,
    WidgetStrip: strip.WidgetStrip,
  };
});

import { resolveFlexDock, RightRailPanel, type RightRailDockModel, type RightRailItem } from './RightRail';

const i18n = createInstance();
beforeAll(async () => {
  const translation = (await (await fetch('/locales/en.json')).json()) as Record<string, unknown>;
  await i18n.init({ initAsync: false, lng: 'en', resources: { en: { translation } } });
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

const interact = (run: () => void): Promise<void> =>
  act(async () => {
    run();
    await Promise.resolve();
  });

const item = (id: string): RightRailItem => ({
  allowMultiple: false,
  icon: () => null,
  id,
  instance: { id, typeId: id },
  isEnabled: true,
  label: id,
  status: 'enabled',
  typeId: id,
  widget: { manifest: { icon: () => null, id } } as never,
});

const noDrop = { helperText: '', isActive: false, isAllowed: false };

/** The rail as the shell would build it from the store: one dock model per region. */
const Rail = () => {
  const store = storeRef.current!;
  const project = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).activeProject;
  const docks = RIGHT_RAIL_DOCKS.map((region): RightRailDockModel => {
    const state = project.widgetRegions[region];
    return {
      activeId: state.instanceIds.includes(state.activeInstanceId) ? state.activeInstanceId : null,
      dropState: noDrop,
      items: state.instanceIds.map(item),
      region,
      state,
    };
  });
  return (
    <RightRailPanel
      docks={docks}
      onRemove={(region, removed) =>
        store.commands.widgets.toggle({ projectId: project.id, region, widgetId: removed.id })
      }
      onSelect={(region, instanceId) =>
        store.commands.widgets.select({ projectId: project.id, region, widgetId: instanceId })
      }
    />
  );
};

const region = (dock: RightRailDock) => storeRef.current!.getSnapshot().activeProject.widgetRegions[dock];
const dockElement = (dock: RightRailDock) => host!.querySelector<HTMLElement>(`[data-rail-dock="${dock}"]`);
const tabsOf = (dock: RightRailDock) =>
  [...(dockElement(dock)?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].map((tab) => ({
    label: tab.textContent,
    selected: tab.getAttribute('aria-selected') === 'true',
  }));
const bodyOf = (dock: RightRailDock) =>
  dockElement(dock)?.querySelector<HTMLElement>('[data-dock-body]')?.dataset.instance;

beforeEach(async () => {
  storeRef.current = createWorkbenchStore();
  storeRef.current.commands.layout.applyPreset('edit');
  host = document.createElement('div');
  host.style.cssText = 'display:flex;height:1000px;width:1000px;';
  document.body.append(host);
  root = createRoot(host);
  await interact(() =>
    root?.render(
      <I18nextProvider i18n={i18n}>
        <ChakraProvider value={system}>
          <FocusRegionProvider>
            <DndContext>
              <Rail />
            </DndContext>
          </FocusRegionProvider>
        </ChakraProvider>
      </I18nextProvider>
    )
  );
});

afterEach(async () => {
  await interact(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  storeRef.current = null;
});

describe('right rail docks', () => {
  it('shows the Edit preset as two docks — Layers and its siblings in the middle, Image Map below — and hides the empty top dock', () => {
    expect(dockElement('rightTop')).toBeNull();
    expect(tabsOf('right')).toEqual([
      { label: 'layers', selected: true },
      { label: 'preview', selected: false },
      { label: 'gallery', selected: false },
      { label: 'queue', selected: false },
    ]);
    expect(tabsOf('rightBottom')).toEqual([{ label: 'image-map', selected: true }]);
    const tab = page.getByRole('tab', { exact: true, name: 'layers' }).element();
    expect(tab.getAttribute('aria-controls')).toBe('rail-dock-right-panel');
    expect(host!.querySelector('#rail-dock-right-panel')?.getAttribute('role')).toBe('tabpanel');
    expect(tab.getAttribute('aria-roledescription')).toBeNull();
    expect(bodyOf('right')).toBe('layers');
    expect(bodyOf('rightBottom')).toBe('image-map');
    expect(Math.round(dockElement('rightBottom')!.getBoundingClientRect().height)).toBe(region('rightBottom').sizePx);
    expect(dockElement('right')!.getBoundingClientRect().height).toBeGreaterThan(400);
    expect(host!.querySelector('[data-chrome-actions="layers"]')).not.toBeNull();
  });

  it('switches the dock body from its tabs, by pointer and by arrow keys, without collapsing on the active tab', async () => {
    await interact(() =>
      page
        .getByRole('tab', { exact: true, name: 'preview' })
        .element()
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    );
    expect(region('right').activeInstanceId).toBe('preview');
    expect(bodyOf('right')).toBe('preview');

    await interact(() =>
      page
        .getByRole('tab', { exact: true, name: 'preview' })
        .element()
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    );
    expect(region('right').isCollapsed).toBe(false);

    (page.getByRole('tab', { exact: true, name: 'preview' }).element() as HTMLElement).focus();
    await act(() => userEvent.keyboard('{ArrowRight}'));
    expect(document.activeElement?.textContent).toBe('gallery');
    await act(() => userEvent.keyboard('{End}'));
    expect(document.activeElement?.textContent).toBe('queue');
    await act(() => userEvent.keyboard('{ArrowRight}'));
    expect(document.activeElement?.textContent).toBe('layers');
  });

  it('collapses a dock to its tab strip and expands it again', async () => {
    await interact(() =>
      page
        .getByRole('button', { exact: true, name: 'Collapse bottom dock' })
        .element()
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    );
    expect(region('rightBottom').isCollapsed).toBe(true);
    expect(bodyOf('rightBottom')).toBeUndefined();
    expect(dockElement('rightBottom')!.getBoundingClientRect().height).toBeLessThan(48);
    expect(tabsOf('rightBottom')).toEqual([{ label: 'image-map', selected: true }]);

    await interact(() =>
      page
        .getByRole('button', { exact: true, name: 'Expand bottom dock' })
        .element()
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    );
    expect(region('rightBottom').isCollapsed).toBe(false);
    expect(bodyOf('rightBottom')).toBe('image-map');
  });

  it('resizes the bottom dock from its handle by keyboard and collapses it below the floor', async () => {
    const handle = page.getByRole('separator', { exact: true, name: 'Resize bottom dock' });
    const start = region('rightBottom').sizePx;
    (handle.element() as HTMLElement).focus();
    await act(() => userEvent.keyboard('{ArrowUp}'));
    expect(region('rightBottom').sizePx).toBe(start + 16);
    await act(() => userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}'));
    expect(region('rightBottom').sizePx).toBe(start - 16);
    await act(() => userEvent.keyboard('{Home}'));
    expect(region('rightBottom').sizePx).toBe(120);
    await act(() => userEvent.keyboard('{ArrowDown}'));
    expect(region('rightBottom').isCollapsed).toBe(true);
  });

  it('resizes the bottom dock by dragging its top edge, previewing live and committing once on release', async () => {
    const handle = page.getByRole('separator', { exact: true, name: 'Resize bottom dock' }).element();
    const start = region('rightBottom').sizePx;
    await interact(() => handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientY: 700 })));
    await interact(() => window.dispatchEvent(new PointerEvent('pointermove', { clientY: 600 })));
    expect(region('rightBottom').sizePx).toBe(start);
    expect(Math.round(dockElement('rightBottom')!.getBoundingClientRect().height)).toBe(start + 100);
    await interact(() => window.dispatchEvent(new PointerEvent('pointerup', { clientY: 600 })));
    expect(region('rightBottom').sizePx).toBe(start + 100);

    await interact(() => handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientY: 600 })));
    await interact(() => window.dispatchEvent(new PointerEvent('pointermove', { clientY: 650 })));
    await interact(() => window.dispatchEvent(new PointerEvent('pointercancel', { clientY: 650 })));
    expect(region('rightBottom').sizePx).toBe(start + 100);
  });

  it('follows a widget between docks: the top dock appears when it gains a widget and a dock with nothing left disappears', async () => {
    const store = storeRef.current!;
    await interact(() =>
      store.commands.widgets.move({
        fromRegion: 'rightBottom',
        instanceId: 'image-map',
        toIndex: 0,
        toRegion: 'rightTop',
      })
    );
    expect(dockElement('rightBottom')).toBeNull();
    expect(tabsOf('rightTop')).toEqual([{ label: 'image-map', selected: true }]);
    expect([...host!.querySelectorAll<HTMLElement>('[data-rail-dock]')].map((el) => el.dataset.railDock)).toEqual([
      'rightTop',
      'right',
    ]);
    expect(page.getByRole('separator', { exact: true, name: 'Resize top dock' }).element()).not.toBeNull();
  });

  it('shuts every dock when the rail panel is dragged closed', async () => {
    const handle = page.getByRole('separator', { exact: true, name: 'Resize right widget panel' }).element();
    const start = region('right').sizePx;
    await interact(() => handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 0 })));
    await interact(() => window.dispatchEvent(new PointerEvent('pointermove', { clientX: start - 260 })));
    await interact(() => window.dispatchEvent(new PointerEvent('pointerup', { clientX: start - 260 })));
    expect(region('right').isCollapsed).toBe(true);
    expect(region('rightBottom').isCollapsed).toBe(true);
  });

  it('gives the spare height to the middle dock, or to the last dock with a widget', () => {
    expect(
      resolveFlexDock([
        { items: [1], region: 'rightTop' },
        { items: [], region: 'right' },
        { items: [1], region: 'rightBottom' },
      ])
    ).toBe('rightBottom');
    expect(
      resolveFlexDock([
        { items: [1], region: 'rightTop' },
        { items: [1], region: 'right' },
        { items: [], region: 'rightBottom' },
      ])
    ).toBe('right');
    expect(
      resolveFlexDock([
        { items: [], region: 'rightTop' },
        { items: [], region: 'right' },
        { items: [], region: 'rightBottom' },
      ])
    ).toBeNull();
  });
});
