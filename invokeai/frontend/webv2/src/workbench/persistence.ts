import type { HydratedWorkbenchSnapshot, PersistedWorkbenchSnapshotV1 } from '@workbench/persistenceContracts';
import type { Project, RefusedWorkbenchProject, WorkbenchState } from '@workbench/projectContracts';

import { getGalleryPage, getGallerySettings } from '@features/gallery/contracts';

import { timeWorkbenchPerf } from './performanceMarks';
import { gateProjectCanvases } from './projectCanvasGate';

const BASE_STORAGE_KEY = 'invokeai:v7:webv2:workbench';
const REFUSED_STORAGE_SUFFIX = ':refused-projects';
const WORKBENCH_SCHEMA_VERSION = 1;

export interface WorkbenchPersistenceService {
  loadWorkbench(): Promise<HydratedWorkbenchSnapshot | null>;
  saveWorkbench(state: WorkbenchState): Promise<HydratedWorkbenchSnapshot>;
  clearWorkbench(): Promise<void>;
  /** Drops a refused project's retained raw document, e.g. after the project is deleted. */
  forgetRefusedProject(projectId: string): Promise<void>;
}

const isBrowser = (): boolean => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

/**
 * In infinite mode the gallery's `galleryPage` is not a page number but the
 * anchor of a mid-board window, set by a reveal from the image map. That is a
 * "you are here" position for the current session: restored a day later it
 * would open the gallery stranded in the middle of a board, with no page
 * control (the footer's is paginated-only) and no way back to the top short of
 * switching boards. Paginated pages stay persisted — there the value really is
 * the page the user was reading.
 */
const stripInfiniteWindowAnchor = (project: Project): Project => {
  let didChange = false;
  const widgetInstances = Object.fromEntries(
    Object.entries(project.widgetInstances).map(([instanceId, instance]) => {
      const values = instance.state.values;

      if (
        instance.typeId !== 'gallery' ||
        getGallerySettings(values).paginationMode !== 'infinite' ||
        getGalleryPage(values) === 0
      ) {
        return [instanceId, instance];
      }

      didChange = true;
      return [instanceId, { ...instance, state: { ...instance.state, values: { ...values, galleryPage: 0 } } }];
    })
  );

  return didChange ? { ...project, widgetInstances } : project;
};

export const stripTransientWorkbenchState = (state: WorkbenchState): WorkbenchState => {
  const { errorLog: _legacyErrorLog, ...nextState } = state as WorkbenchState & { errorLog?: string[] };

  return {
    ...nextState,
    notifications: [],
    // Project undo/redo is deliberately session-only. Normalize legacy cache
    // snapshots immediately and never let full-project undo entries consume
    // localStorage quota or grow across browser sessions.
    projects: nextState.projects.map((project) => ({
      ...stripInfiniteWindowAnchor(project),
      undoRedo: { future: [], past: [] },
    })),
  };
};

const createSnapshot = (state: WorkbenchState): HydratedWorkbenchSnapshot => ({
  refusedProjects: [],
  savedAt: new Date().toISOString(),
  state: stripTransientWorkbenchState(state),
  version: WORKBENCH_SCHEMA_VERSION,
});

const isWorkbenchState = (value: unknown): value is WorkbenchState => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;

  return Array.isArray(record.projects) && typeof record.activeProjectId === 'string';
};

export const hydratePersistedWorkbenchSnapshot = (value: unknown): HydratedWorkbenchSnapshot | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Partial<PersistedWorkbenchSnapshotV1> & { schemaVersion?: number };
  const version = record.version ?? record.schemaVersion;

  if (version !== WORKBENCH_SCHEMA_VERSION || !isWorkbenchState(record.state)) {
    return null;
  }

  const state = record.state;
  const projects: Project[] = [];
  const refusedProjects: RefusedWorkbenchProject[] = [];

  for (const project of state.projects) {
    const refused = gateProjectCanvases(project);

    if (refused) {
      refusedProjects.push(refused);
    } else {
      projects.push(project);
    }
  }

  const activeProjectId = projects.some((project) => project.id === state.activeProjectId)
    ? state.activeProjectId
    : (projects[0]?.id ?? '');

  return {
    refusedProjects,
    savedAt: typeof record.savedAt === 'string' ? record.savedAt : new Date().toISOString(),
    state: stripTransientWorkbenchState({ ...state, activeProjectId, projects }),
    version: WORKBENCH_SCHEMA_VERSION,
  };
};

export const serializeWorkbenchPersistenceSnapshot = (
  snapshot: HydratedWorkbenchSnapshot
): PersistedWorkbenchSnapshotV1 => ({
  savedAt: snapshot.savedAt,
  state: snapshot.state,
  version: WORKBENCH_SCHEMA_VERSION,
});

/**
 * Construct one account-owned browser cache. The suffix is captured once,
 * rather than read from mutable auth state when a debounced save eventually
 * executes, so work started by account A can never land in account B's bucket.
 *
 * Projects the canvas version gate refuses move into a sibling bucket, untouched,
 * until they are explicitly forgotten.
 */
export const createLocalStorageWorkbenchPersistence = (storageSuffix: string): WorkbenchPersistenceService => {
  const storageKey = `${BASE_STORAGE_KEY}${storageSuffix}`;
  const refusedKey = `${storageKey}${REFUSED_STORAGE_SUFFIX}`;

  const readRefused = (): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(refusedKey) ?? '{}');

      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  const writeRefused = (refused: Record<string, unknown>): void => {
    try {
      if (Object.keys(refused).length === 0) {
        window.localStorage.removeItem(refusedKey);
      } else {
        window.localStorage.setItem(refusedKey, JSON.stringify(refused));
      }
    } catch {
      // Cache only; the server copy, when there is one, is untouched.
    }
  };

  const retainRefused = (refusedProjects: readonly RefusedWorkbenchProject[]): void => {
    if (refusedProjects.length === 0) {
      return;
    }
    const refused = readRefused();

    for (const project of refusedProjects) {
      if (project.projectId) {
        refused[project.projectId] = project.raw;
      }
    }
    writeRefused(refused);
  };

  return {
    clearWorkbench() {
      if (!isBrowser()) {
        return Promise.resolve();
      }

      window.localStorage.removeItem(storageKey);
      window.localStorage.removeItem(refusedKey);

      return Promise.resolve();
    },
    forgetRefusedProject(projectId) {
      if (isBrowser()) {
        const refused = readRefused();

        delete refused[projectId];
        writeRefused(refused);
      }

      return Promise.resolve();
    },
    loadWorkbench() {
      if (!isBrowser()) {
        return Promise.resolve(null);
      }

      const value = window.localStorage.getItem(storageKey);

      if (!value) {
        return Promise.resolve(null);
      }

      try {
        const snapshot = hydratePersistedWorkbenchSnapshot(JSON.parse(value));

        if (snapshot && snapshot.refusedProjects.length > 0) {
          retainRefused(snapshot.refusedProjects);
          window.localStorage.setItem(storageKey, JSON.stringify(serializeWorkbenchPersistenceSnapshot(snapshot)));
        }

        return Promise.resolve(snapshot);
      } catch {
        window.localStorage.removeItem(storageKey);

        return Promise.resolve(null);
      }
    },
    saveWorkbench(state) {
      const snapshot = createSnapshot(state);

      if (!isBrowser()) {
        return Promise.resolve(snapshot);
      }

      try {
        window.localStorage.setItem(
          storageKey,
          timeWorkbenchPerf(
            'workbench:persistence-localstorage-stringify',
            { area: 'persistence', kind: 'workbench', projectId: state.activeProjectId },
            () => JSON.stringify(serializeWorkbenchPersistenceSnapshot(snapshot))
          )
        );
      } catch {
        // The backend remains the source of truth; localStorage is only an offline cache.
      }

      return Promise.resolve(snapshot);
    },
  };
};
