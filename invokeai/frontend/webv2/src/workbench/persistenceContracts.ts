import type { RefusedWorkbenchProject, WorkbenchState } from './projectContracts';

export interface HydratedWorkbenchSnapshot {
  version: 1;
  savedAt: string;
  state: WorkbenchState;
  /** Persisted projects this client refused to load. They are absent from `state`. */
  refusedProjects: RefusedWorkbenchProject[];
}

/** Versioned storage wire shape. `state` is untrusted until the persistence adapter maps it. */
export interface PersistedWorkbenchSnapshotV1 {
  version: 1;
  savedAt: string;
  state: unknown;
}
