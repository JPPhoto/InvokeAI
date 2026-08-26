import type { CanvasDocumentContractV2, LayerStackKind } from '@workbench/canvas-engine/api';

import { registerAccountOwnedResource } from '@platform/state/accountLifecycle';
import { createExternalStore } from '@platform/state/externalStore';

/**
 * Transient Layers-panel state, kept per project and outside the document, its snapshots and
 * history. The primary selection stays `document.selectedLayerId`; `primaryId` mirrors the value
 * this state was built against so an external primary change collapses stale secondaries.
 */
export interface LayerPanelState {
  readonly projectId: string;
  readonly primaryId: string | null;
  readonly anchorId: string | null;
  readonly selectedIds: readonly string[];
  readonly collapsedStacks: readonly LayerStackKind[];
}

export interface LayerSelectionModifiers {
  additive: boolean;
  range: boolean;
}

export interface LayerPanelSelectionUpdate {
  projectId: string;
  primaryId: string | null;
  selectedIds: readonly string[];
  anchorId?: string | null;
}

interface LayerPanelStore {
  readonly byProject: Readonly<Record<string, LayerPanelState>>;
}

const store = createExternalStore<LayerPanelStore>({ byProject: {} });

export const createLayerPanelState = (
  projectId: string,
  primaryId: string | null,
  collapsedStacks: readonly LayerStackKind[] = []
): LayerPanelState => ({
  anchorId: primaryId,
  collapsedStacks,
  primaryId,
  projectId,
  selectedIds: primaryId ? [primaryId] : [],
});

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

export const isSameLayerPanelState = (left: LayerPanelState, right: LayerPanelState): boolean =>
  left.projectId === right.projectId &&
  left.primaryId === right.primaryId &&
  left.anchorId === right.anchorId &&
  sameIds(left.selectedIds, right.selectedIds) &&
  sameIds(left.collapsedStacks, right.collapsedStacks);

const stateFor = (snapshot: LayerPanelStore, projectId: string, primaryId: string | null): LayerPanelState => {
  const stored = snapshot.byProject[projectId];
  if (!stored) {
    return createLayerPanelState(projectId, primaryId);
  }
  return stored.primaryId === primaryId ? stored : createLayerPanelState(projectId, primaryId, stored.collapsedStacks);
};

export const readLayerPanelState = (projectId: string, primaryId: string | null): LayerPanelState =>
  stateFor(store.getSnapshot(), projectId, primaryId);

export const useLayerPanelState = (projectId: string, primaryId: string | null): LayerPanelState =>
  store.useSelector((snapshot) => stateFor(snapshot, projectId, primaryId), isSameLayerPanelState);

const write = (state: LayerPanelState): void => {
  const { byProject } = store.getSnapshot();
  const current = byProject[state.projectId];
  if (current && isSameLayerPanelState(current, state)) {
    return;
  }
  store.setSnapshot({ byProject: { ...byProject, [state.projectId]: state } });
};

/** Records a panel-originated selection; publish before dispatching a new primary so reconciliation keeps it. */
export const publishLayerPanelSelection = (selection: LayerPanelSelectionUpdate): void => {
  write({
    anchorId: selection.anchorId ?? selection.primaryId,
    collapsedStacks: store.getSnapshot().byProject[selection.projectId]?.collapsedStacks ?? [],
    primaryId: selection.primaryId,
    projectId: selection.projectId,
    selectedIds: [...selection.selectedIds],
  });
};

export const toggleLayerStackCollapsed = (projectId: string, primaryId: string | null, stack: LayerStackKind): void => {
  const current = readLayerPanelState(projectId, primaryId);
  const collapsedStacks = current.collapsedStacks.includes(stack)
    ? current.collapsedStacks.filter((candidate) => candidate !== stack)
    : [...current.collapsedStacks, stack];
  write({ ...current, collapsedStacks });
};

/** Keeps a state valid after an external primary change, a project switch, or a layer removal. */
export const reconcileLayerPanelState = (
  state: LayerPanelState,
  projectId: string,
  orderedIds: readonly string[],
  primaryId: string | null
): LayerPanelState => {
  const existing = new Set(orderedIds);
  const validPrimaryId = primaryId && existing.has(primaryId) ? primaryId : null;
  if (state.projectId !== projectId || state.primaryId !== validPrimaryId) {
    return createLayerPanelState(projectId, validPrimaryId, state.projectId === projectId ? state.collapsedStacks : []);
  }
  const selectedIds = [...new Set(state.selectedIds)].filter((id) => existing.has(id));
  if (validPrimaryId && !selectedIds.includes(validPrimaryId)) {
    selectedIds.push(validPrimaryId);
  }
  const anchorId = state.anchorId && existing.has(state.anchorId) ? state.anchorId : validPrimaryId;
  if (anchorId === state.anchorId && sameIds(selectedIds, state.selectedIds)) {
    return state;
  }
  return { ...state, anchorId, selectedIds };
};

/**
 * Applies plain, Ctrl/Cmd-toggle, and Shift-range row selection semantics over the rows the panel
 * renders; an additive range keeps selected rows hidden inside collapsed stacks.
 */
export const selectLayerInPanel = (
  state: LayerPanelState,
  layerId: string,
  orderedIds: readonly string[],
  modifiers: LayerSelectionModifiers
): LayerPanelState => {
  if (!orderedIds.includes(layerId)) {
    return state;
  }
  if (modifiers.range) {
    const anchorId = state.anchorId && orderedIds.includes(state.anchorId) ? state.anchorId : layerId;
    const start = orderedIds.indexOf(anchorId);
    const end = orderedIds.indexOf(layerId);
    const rangeIds = orderedIds.slice(Math.min(start, end), Math.max(start, end) + 1);
    const selected = new Set(modifiers.additive ? [...state.selectedIds, ...rangeIds] : rangeIds);
    const hidden = modifiers.additive ? state.selectedIds.filter((id) => !orderedIds.includes(id)) : [];
    return {
      ...state,
      anchorId,
      primaryId: layerId,
      selectedIds: [...orderedIds.filter((id) => selected.has(id)), ...hidden],
    };
  }
  if (modifiers.additive) {
    const selected = new Set(state.selectedIds);
    const wasSelected = selected.has(layerId);
    if (wasSelected) {
      selected.delete(layerId);
    } else {
      selected.add(layerId);
    }
    const selectedIds = orderedIds.filter((id) => selected.has(id));
    const primaryId = wasSelected
      ? state.primaryId === layerId || !state.primaryId || !selected.has(state.primaryId)
        ? (selectedIds[0] ?? null)
        : state.primaryId
      : layerId;
    return { ...state, anchorId: layerId, primaryId, selectedIds };
  }
  return { ...state, anchorId: layerId, primaryId: layerId, selectedIds: [layerId] };
};

export interface LayerPanelProjectView {
  readonly id: string;
  readonly canvas: { readonly document: Pick<CanvasDocumentContractV2, 'layers' | 'selectedLayerId'> };
}

const reconciledDocuments = new Map<string, LayerPanelProjectView['canvas']['document']>();

/** Reconciles every stored state with its project after a store transition and forgets closed projects. */
export const reconcileLayerPanelStates = (projects: readonly LayerPanelProjectView[]): void => {
  const { byProject } = store.getSnapshot();
  const next: Record<string, LayerPanelState> = {};
  let changed = false;
  for (const project of projects) {
    const stored = byProject[project.id];
    if (!stored) {
      continue;
    }
    const { document } = project.canvas;
    if (reconciledDocuments.get(project.id) === document) {
      next[project.id] = stored;
      continue;
    }
    reconciledDocuments.set(project.id, document);
    const reconciled = reconcileLayerPanelState(
      stored,
      project.id,
      document.layers.map((layer) => layer.id),
      document.selectedLayerId
    );
    next[project.id] = reconciled;
    changed ||= reconciled !== stored;
  }
  for (const id of reconciledDocuments.keys()) {
    if (!(id in next)) {
      reconciledDocuments.delete(id);
    }
  }
  if (changed || Object.keys(next).length !== Object.keys(byProject).length) {
    store.setSnapshot({ byProject: next });
  }
};

export const clearLayerPanelStates = (): void => {
  reconciledDocuments.clear();
  if (Object.keys(store.getSnapshot().byProject).length > 0) {
    store.setSnapshot({ byProject: {} });
  }
};

registerAccountOwnedResource({ clear: clearLayerPanelStates, name: 'layer-panel-state' });
