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
  /**
   * Moves raw documents this client cannot open into the recovery bucket without rewriting them.
   * Returns false when the recovery bucket could not be written.
   */
  retainRefusedProjects(refusedProjects: readonly RefusedWorkbenchProject[]): Promise<boolean>;
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
  hasUnretainedRefusedProjects: false,
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
    hasUnretainedRefusedProjects: false,
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

  const writeRefused = (refused: Record<string, unknown>): boolean => {
    try {
      if (Object.keys(refused).length === 0) {
        window.localStorage.removeItem(refusedKey);
      } else {
        window.localStorage.setItem(refusedKey, JSON.stringify(refused));
      }
      return true;
    } catch {
      return false;
    }
  };

  const retainRefused = (refusedProjects: readonly RefusedWorkbenchProject[]): boolean => {
    if (refusedProjects.length === 0) {
      return true;
    }
    const refused = readRefused();

    for (const project of refusedProjects) {
      // A server refusal carries metadata only. Never let it erase a raw local recovery document
      // retained for the same id.
      if (project.projectId && project.raw !== null && project.raw !== undefined) {
        refused[project.projectId] = project.raw;
      }
    }
    return writeRefused(refused);
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

      let snapshot: HydratedWorkbenchSnapshot | null;

      try {
        snapshot = hydratePersistedWorkbenchSnapshot(JSON.parse(value));
      } catch {
        window.localStorage.removeItem(storageKey);

        return Promise.resolve(null);
      }

      if (snapshot && snapshot.refusedProjects.length > 0) {
        if (retainRefused(snapshot.refusedProjects)) {
          // The raw recovery copy is durable. Only now is it safe to compact the ordinary cache. A
          // compaction failure leaves the original value intact; it is not evidence of corrupt input.
          try {
            window.localStorage.setItem(storageKey, JSON.stringify(serializeWorkbenchPersistenceSnapshot(snapshot)));
          } catch {
            // Retaining the original primary cache is the recovery path.
          }
        } else {
          snapshot = { ...snapshot, hasUnretainedRefusedProjects: true };
        }
      }

      return Promise.resolve(snapshot);
    },
    retainRefusedProjects(refusedProjects) {
      return Promise.resolve(!isBrowser() || retainRefused(refusedProjects));
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
      } catch (error) {
        return Promise.reject(error);
      }

      return Promise.resolve(snapshot);
    },
  };
};
