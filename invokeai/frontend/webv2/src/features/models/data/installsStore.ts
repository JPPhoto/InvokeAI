import type { ModelInstallJob, ModelInstallStatus } from '@features/models/core/types';

import {
  type AccountScope,
  captureAccountScope,
  isAccountScopeCurrent,
  registerAccountOwnedResource,
} from '@platform/state/accountLifecycle';
import { createExternalStore, createKeyedTransientStore } from '@platform/state/externalStore';
import { createTrailingSingleFlight } from '@platform/state/singleFlight';
import { getApiErrorMessage } from '@platform/transport/http';

import { listModelInstalls } from './api';
import { refreshModels } from './modelsStore';
import { refreshStartersIfLoaded } from './startersStore';

/**
 * REST owns install jobs; lifecycle events refresh them. High-frequency progress bypasses the list and subscribes
 * per job to limit renders.
 */

export interface InstallsSnapshot {
  jobs: ModelInstallJob[];
  status: 'idle' | 'loading' | 'loaded' | 'error';
  error: string | null;
}

export interface InstallDownloadProgress {
  bytes: number;
  totalBytes: number;
}

/** A just-settled install, surfaced so the UI can toast success/failure. */
export interface InstallOutcome {
  id: number;
  jobId: number;
  kind: 'completed' | 'error' | 'cancelled';
  modelName: string | null;
  source: string;
  error: string | null;
}

/**
 * Normalize typed and socket source labels identically for matching; colocate here to keep taxonomy out of eager
 * chunks.
 */
export const getInstallSourceLabel = (source: unknown): string => {
  if (typeof source === 'string') {
    return source;
  }

  if (source && typeof source === 'object') {
    const record = source as Record<string, unknown>;

    for (const field of ['repo_id', 'url', 'path'] as const) {
      const value = record[field];

      if (typeof value === 'string') {
        return value;
      }
    }
  }

  return 'model';
};

const REFRESH_COALESCE_MS = 250;
// Bound display history with room for completion bursts between toast flushes.
const OUTCOME_LIMIT = 64;

const EMPTY_INSTALLS_SNAPSHOT: InstallsSnapshot = { error: null, jobs: [], status: 'idle' };
const EMPTY_INSTALL_OUTCOMES: { outcomes: InstallOutcome[] } = { outcomes: [] };

const store = createExternalStore<InstallsSnapshot>(EMPTY_INSTALLS_SNAPSHOT);
const outcomesStore = createExternalStore<{ outcomes: InstallOutcome[] }>(EMPTY_INSTALL_OUTCOMES);
let nextOutcomeId = 1;

const progressByJobId = createKeyedTransientStore<number, InstallDownloadProgress>();

const refreshFlight = createTrailingSingleFlight();
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let catalogRefreshTimer: ReturnType<typeof setTimeout> | null = null;

registerAccountOwnedResource({
  clear: () => {
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }

    if (catalogRefreshTimer !== null) {
      clearTimeout(catalogRefreshTimer);
      catalogRefreshTimer = null;
    }

    refreshFlight.reset();
    nextOutcomeId = 1;
    progressByJobId.clear();
    outcomesStore.setSnapshot(EMPTY_INSTALL_OUTCOMES);
    store.setSnapshot(EMPTY_INSTALLS_SNAPSHOT);
  },
  name: 'model-installs',
});

export const refreshInstalls = (owner: AccountScope = captureAccountScope()): Promise<void> =>
  refreshFlight.run(() => {
    store.patchSnapshot({ status: store.getSnapshot().status === 'loaded' ? 'loaded' : 'loading' });

    return listModelInstalls(owner.signal)
      .then((jobs) => {
        if (!isAccountScopeCurrent(owner)) {
          return;
        }

        const activeJobIds = new Set(jobs.map((job) => job.id));

        for (const [jobId] of progressByJobId.entries()) {
          if (!activeJobIds.has(jobId)) {
            progressByJobId.delete(jobId);
          }
        }

        store.patchSnapshot({ error: null, jobs, status: 'loaded' });
      })
      .catch((error: unknown) => {
        if (!isAccountScopeCurrent(owner)) {
          return;
        }

        store.patchSnapshot({
          error: getApiErrorMessage(error, 'Failed to load install queue.'),
          status: store.getSnapshot().jobs.length > 0 ? 'loaded' : 'error',
        });
      });
  });

/** Fetch on first use or retry after an error, so one failed load never sticks. */
export const ensureInstallsLoaded = (): void => {
  const { status } = store.getSnapshot();

  if (status === 'idle' || status === 'error') {
    void refreshInstalls();
  }
};

const scheduleRefresh = (): void => {
  if (refreshTimer !== null) {
    return;
  }

  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshInstalls();
  }, REFRESH_COALESCE_MS);
};

/** Coalesce install-completion bursts into one library/starter revalidation. */
const scheduleCatalogRefresh = (): void => {
  if (catalogRefreshTimer !== null) {
    return;
  }

  catalogRefreshTimer = setTimeout(() => {
    catalogRefreshTimer = null;
    void refreshModels();
    refreshStartersIfLoaded();
  }, REFRESH_COALESCE_MS);
};

/** Optimistically replace one job (e.g. after pause/resume API calls). */
export const replaceInstallJob = (job: ModelInstallJob): void => {
  store.patchSnapshot({
    jobs: store.getSnapshot().jobs.map((existing) => (existing.id === job.id ? job : existing)),
  });
};

/** Optimistically add a freshly created job so the queue updates instantly. */
export const addInstallJob = (job: ModelInstallJob): void => {
  if (store.getSnapshot().jobs.some((existing) => existing.id === job.id)) {
    replaceInstallJob(job);
    return;
  }

  store.patchSnapshot({ jobs: [job, ...store.getSnapshot().jobs], status: 'loaded' });
};

const recordOutcome = (outcome: Omit<InstallOutcome, 'id'>): void => {
  outcomesStore.patchSnapshot({
    outcomes: [{ ...outcome, id: nextOutcomeId }, ...outcomesStore.getSnapshot().outcomes].slice(0, OUTCOME_LIMIT),
  });
  nextOutcomeId += 1;
};

interface ModelInstallSocketPayload {
  id: number;
  bytes?: number;
  total_bytes?: number;
  source?: unknown;
  error?: string | null;
  error_type?: string | null;
  config?: { name?: string } | null;
}

export const MODEL_INSTALL_SOCKET_EVENTS = [
  'model_install_started',
  'model_install_download_started',
  'model_install_download_progress',
  'model_install_downloads_complete',
  'model_install_complete',
  'model_install_error',
  'model_install_cancelled',
] as const;

export type ModelInstallSocketEvent = (typeof MODEL_INSTALL_SOCKET_EVENTS)[number];

/** Socket sink — wired into the backend socket by the queue coordinator. */
export const handleModelInstallSocketEvent = (
  event: ModelInstallSocketEvent,
  payload: unknown,
  owner: AccountScope = captureAccountScope()
): void => {
  if (!isAccountScopeCurrent(owner)) {
    return;
  }

  const data = payload as ModelInstallSocketPayload;

  if (typeof data?.id !== 'number') {
    return;
  }

  if (event === 'model_install_download_progress') {
    progressByJobId.set(data.id, { bytes: data.bytes ?? 0, totalBytes: data.total_bytes ?? 0 });

    const job = store.getSnapshot().jobs.find((candidate) => candidate.id === data.id);

    if (!job) {
      // The first progress tick may arrive for a job created in another
      // client; make sure the row exists without refetching on every tick.
      scheduleRefresh();
    } else if (job.status === 'waiting') {
      // Bytes are flowing, so the REST snapshot's `waiting` is stale. Patch
      // locally so download controls (pause/cancel) appear immediately.
      replaceInstallJob({ ...job, status: 'downloading' });
    }

    return;
  }

  if (event === 'model_install_complete' || event === 'model_install_error' || event === 'model_install_cancelled') {
    // Retain settled jobs until cleared, but release their inactive byte-progress state.
    progressByJobId.delete(data.id);
  }

  if (event === 'model_install_complete') {
    recordOutcome({
      error: null,
      jobId: data.id,
      kind: 'completed',
      modelName: data.config?.name ?? null,
      source: getInstallSourceLabel(data.source),
    });
    scheduleCatalogRefresh();
  } else if (event === 'model_install_error') {
    recordOutcome({
      error: data.error ?? data.error_type ?? 'Unknown install error.',
      jobId: data.id,
      kind: 'error',
      modelName: null,
      source: getInstallSourceLabel(data.source),
    });
  } else if (event === 'model_install_cancelled') {
    recordOutcome({
      error: null,
      jobId: data.id,
      kind: 'cancelled',
      modelName: null,
      source: getInstallSourceLabel(data.source),
    });
  }

  scheduleRefresh();
};

const ACTIVE_STATUSES: ModelInstallStatus[] = ['waiting', 'downloading', 'downloads_done', 'running'];

export const isActiveInstallStatus = (status: ModelInstallStatus): boolean => ACTIVE_STATUSES.includes(status);

export const useInstallsSelector = store.useSelector;

export const getInstallsSnapshot = (): InstallsSnapshot => store.getSnapshot();

/** Cache active source strings by jobs-array identity for installing affordances. */
const areSetsEqual = <Value>(left: ReadonlySet<Value>, right: ReadonlySet<Value>): boolean =>
  left.size === right.size && Array.from(left).every((value) => right.has(value));

const getActiveInstallSources = (jobs: ModelInstallJob[]): ReadonlySet<string> =>
  new Set(
    jobs
      .filter((job) => isActiveInstallStatus(job.status) || job.status === 'paused')
      .map((job) => getInstallSourceLabel(job.source))
  );

export const useActiveInstallSources = (): ReadonlySet<string> =>
  store.useSelector((snapshot) => getActiveInstallSources(snapshot.jobs), areSetsEqual);

export const useInstallProgress = (jobId: number): InstallDownloadProgress | null =>
  progressByJobId.useValue(jobId) ?? null;

export const getInstallProgress = (jobId: number): InstallDownloadProgress | null => progressByJobId.get(jobId) ?? null;

export const useInstallOutcomes = (): InstallOutcome[] => outcomesStore.useSelector((snapshot) => snapshot.outcomes);

export const getInstallOutcomes = (): InstallOutcome[] => outcomesStore.getSnapshot().outcomes;
