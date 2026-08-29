import { describe, expect, it } from 'vitest';

import type { LayoutPreset, LayoutPresetSnapshot, WidgetRegionState } from './layoutContracts';
import type { Project, WorkbenchState } from './projectContracts';

import { getLayoutPreset } from './layoutPresets';
import { areLayoutPresetSnapshotsEqual, doesProjectMatchLayoutPreset } from './layoutPresetSnapshots';
import { createInitialWorkbenchState, normalizeWorkbenchAccount, resolvePanelToggle } from './workbenchState';
import { workbenchReducer } from './workbenchState.testing';

const activeProject = (state: WorkbenchState): Project =>
  state.projects.find((project) => project.id === state.activeProjectId)!;

const editState = (): WorkbenchState =>
  workbenchReducer(createInitialWorkbenchState(), { presetId: 'edit', type: 'applyPreset' });

/** The Edit preset as an account saved it before the rail had docks. */
const preDockEditSnapshot = (): LayoutPresetSnapshot => {
  const { rightBottom: _bottom, rightTop: _top, ...regions } = getLayoutPreset('edit').snapshot.widgetRegions;
  const right: WidgetRegionState = {
    ...regions.right,
    instanceIds: ['layers', 'preview', 'gallery', 'image-map', 'queue'],
  };
  const snapshot = getLayoutPreset('edit').snapshot;
  const widgetRegions = { ...regions, right } as LayoutPresetSnapshot['widgetRegions'];
  const referenced = new Set(Object.values(widgetRegions).flatMap((region) => region.instanceIds));
  return {
    layout: { ...snapshot.layout, panels: { ...snapshot.layout.panels } },
    widgetInstances: Object.fromEntries(
      Object.entries(snapshot.widgetInstances).filter(([instanceId]) => referenced.has(instanceId))
    ),
    widgetRegions,
  };
};

describe('right rail docks', () => {
  it('loads an account whose custom preset and override predate the docks, and treats them as empty docks', () => {
    const custom: LayoutPreset = { id: 'custom-old', label: 'Old', snapshot: preDockEditSnapshot() };
    const account = normalizeWorkbenchAccount({
      customLayoutPresets: [custom],
      layoutPresetOverrides: { edit: preDockEditSnapshot() },
    });

    expect(account.customLayoutPresets?.map((preset) => preset.id)).toEqual(['custom-old']);
    expect(account.customLayoutPresets?.[0]?.snapshot.widgetRegions.rightTop).toMatchObject({
      activeInstanceId: '',
      instanceIds: [],
      isCollapsed: true,
    });
    expect(account.layoutPresetOverrides?.edit?.widgetRegions.rightBottom).toMatchObject({ instanceIds: [] });

    const initial = createInitialWorkbenchState();
    const hydrated = workbenchReducer(initial, {
      state: { ...initial, account: { ...initial.account, customLayoutPresets: [custom] } },
      type: 'hydrateWorkbench',
    });
    const applied = workbenchReducer(hydrated, { presetId: 'custom-old', type: 'applyPreset' });
    expect(activeProject(applied).widgetRegions.right.instanceIds).toContain('image-map');
    expect(activeProject(applied).widgetRegions.rightBottom.instanceIds).toEqual([]);
    // Drift compares a dock-less snapshot as if it carried empty docks.
    expect(
      areLayoutPresetSnapshotsEqual(
        custom.snapshot,
        activeProject(applied).widgetRegions ? { ...custom.snapshot } : custom.snapshot
      )
    ).toBe(true);
    expect(doesProjectMatchLayoutPreset(activeProject(applied), custom)).toBe(true);
  });

  it('keeps a saved preset whose docks are empty', () => {
    const preset: LayoutPreset = { id: 'custom-new', label: 'New', snapshot: getLayoutPreset('compose').snapshot };
    expect(preset.snapshot.widgetRegions.rightTop.activeInstanceId).toBe('');
    expect(normalizeWorkbenchAccount({ customLayoutPresets: [preset] }).customLayoutPresets?.length).toBe(1);
  });

  it('leaves an emptied dock naming no instance, so moving widgets out and back matches the preset again', () => {
    let state = editState();
    const move = (instanceId: string, fromRegion: 'rightTop' | 'rightBottom', toRegion: 'rightTop' | 'rightBottom') =>
      workbenchReducer(state, { fromRegion, instanceId, toIndex: 99, toRegion, type: 'moveWidgetInstance' });
    state = move('properties', 'rightBottom', 'rightTop');
    state = move('transform', 'rightBottom', 'rightTop');
    expect(activeProject(state).widgetRegions.rightBottom).toMatchObject({
      activeInstanceId: '',
      instanceIds: [],
      isCollapsed: true,
    });
    expect(activeProject(state).widgetRegions.rightTop).toMatchObject({
      activeInstanceId: 'transform',
      instanceIds: ['properties', 'transform'],
      isCollapsed: false,
    });

    state = move('properties', 'rightTop', 'rightBottom');
    state = move('transform', 'rightTop', 'rightBottom');
    state = workbenchReducer(state, { region: 'rightBottom', type: 'selectRegionWidget', widgetId: 'properties' });
    expect(doesProjectMatchLayoutPreset(activeProject(state), getLayoutPreset('edit'))).toBe(true);

    const closed = workbenchReducer(
      workbenchReducer(state, { region: 'rightBottom', type: 'toggleRegionWidget', widgetId: 'transform' }),
      { region: 'rightBottom', type: 'toggleRegionWidget', widgetId: 'properties' }
    );
    expect(activeProject(closed).widgetRegions.rightBottom.activeInstanceId).toBe('');

    const floated = workbenchReducer(state, { instanceId: 'properties', type: 'floatWidget' });
    expect(activeProject(floated).widgetRegions.rightBottom).toMatchObject({ activeInstanceId: 'transform' });
    expect(activeProject(floated).floatingWidgets?.properties?.returnRegion).toBe('rightBottom');
  });

  it('reveals an instance already docked elsewhere on the rail instead of placing it twice', () => {
    let state = editState();
    state = workbenchReducer(state, { region: 'rightBottom', type: 'setRegionWidgetCollapsed', isCollapsed: true });
    state = workbenchReducer(state, { region: 'right', type: 'openRegionWidget', widgetId: 'transform' });
    const { right, rightBottom } = activeProject(state).widgetRegions;
    expect(right.instanceIds).not.toContain('transform');
    expect(rightBottom).toMatchObject({ activeInstanceId: 'transform', isCollapsed: false });
  });

  it('migrates a pre-dock Edit rail keeping the rail shut if it was, and leaves a floated Image Map in the middle', () => {
    const initial = createInitialWorkbenchState();
    const preDock = (mutate: (project: Project) => Project): WorkbenchState => ({
      ...initial,
      projects: initial.projects.map((project) => {
        const { rightBottom: _b, rightTop: _t, ...regions } = project.widgetRegions;
        return mutate({
          ...project,
          widgetRegions: {
            ...regions,
            right: {
              ...project.widgetRegions.right,
              instanceIds: ['layers', 'preview', 'gallery', 'image-map', 'queue'],
              isCollapsed: true,
            },
          } as Project['widgetRegions'],
        });
      }),
    });

    const shut = activeProject(workbenchReducer(initial, { state: preDock((p) => p), type: 'hydrateWorkbench' }));
    expect(shut.widgetRegions.rightBottom).toMatchObject({
      instanceIds: ['properties', 'transform'],
      isCollapsed: true,
    });

    const floated = activeProject(
      workbenchReducer(initial, {
        state: preDock((project) => ({
          ...project,
          floatingWidgets: {
            'image-map': {
              heightPx: 300,
              mode: 'windowed',
              returnRegion: 'right',
              stackOrder: 1,
              widthPx: 300,
              x: 0,
              y: 0,
            },
          },
          widgetRegions: {
            ...project.widgetRegions,
            right: { ...project.widgetRegions.right, isCollapsed: false },
          },
        })),
        type: 'hydrateWorkbench',
      })
    );
    expect(floated.floatingWidgets?.['image-map']?.returnRegion).toBe('right');
    expect(floated.widgetRegions.rightBottom).toMatchObject({ instanceIds: ['properties', 'transform'] });
    expect(floated.widgetRegions.right.instanceIds).toEqual(['layers', 'preview', 'gallery', 'queue']);
  });

  it('upgrades the interim rail that docked Image Map alone at the bottom to the shipped docks', () => {
    const initial = createInitialWorkbenchState();
    const interim: WorkbenchState = {
      ...initial,
      projects: initial.projects.map((project) => ({
        ...project,
        widgetRegions: {
          ...project.widgetRegions,
          right: { ...project.widgetRegions.right, instanceIds: ['layers', 'preview', 'gallery', 'queue'] },
          rightBottom: { activeInstanceId: 'image-map', instanceIds: ['image-map'], isCollapsed: false, sizePx: 280 },
          rightTop: { activeInstanceId: '', instanceIds: [], isCollapsed: true, sizePx: 280 },
        },
      })),
    };
    const project = activeProject(workbenchReducer(initial, { state: interim, type: 'hydrateWorkbench' }));
    expect(project.widgetRegions.right.instanceIds).toEqual(['layers', 'preview', 'gallery', 'image-map', 'queue']);
    expect(project.widgetRegions.rightBottom.instanceIds).toEqual(['properties', 'transform']);
    expect(project.widgetInstances.transform?.typeId).toBe('transform');
    expect(project.widgetRegions.rightBottom).toMatchObject({ activeInstanceId: 'properties', isCollapsed: false });
  });

  it('toggles only the docks that hold something', () => {
    const regions = activeProject(editState()).widgetRegions;
    expect(resolvePanelToggle(regions, ['rightTop', 'right', 'rightBottom'])).toEqual({
      regions: ['right', 'rightBottom'],
      shouldCollapse: true,
    });
    const collapsed = {
      ...regions,
      right: { ...regions.right, isCollapsed: true },
      rightBottom: { ...regions.rightBottom, isCollapsed: true },
      rightTop: { ...regions.rightTop, isCollapsed: false },
    };
    expect(resolvePanelToggle(collapsed, ['rightTop', 'right', 'rightBottom'])).toEqual({
      regions: ['right', 'rightBottom'],
      shouldCollapse: false,
    });
  });
});
