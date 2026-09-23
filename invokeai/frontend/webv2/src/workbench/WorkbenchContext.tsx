import type { ProjectLayoutState } from '@workbench/layoutContracts';
import type { Project } from '@workbench/projectContracts';
import type { ProjectSettings } from '@workbench/settings/contracts';
import type { WidgetInstanceId, WidgetTypeId } from '@workbench/widgetContracts';

import { createUuid } from '@platform/browser/randomUuid';
import { useMountEffect } from '@platform/react/useMountEffect';
import { captureAccountScope, type AccountScope } from '@platform/state/accountLifecycle';
import { shallowEqual as selectorShallowEqual, useExternalStoreSelector } from '@platform/state/selectors';
import { apiFetch } from '@platform/transport/http';
import { createContext, use, useEffect, useSyncExternalStore, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { ProjectPushOutcome } from './projects/projectFlush';

import { WorkbenchSplashScreen } from './components/WorkbenchSplashScreen';
import { WorkbenchUnavailableScreen } from './components/WorkbenchUnavailableScreen';
import { createExtensionRegistry, type ExtensionRegistry } from './extensions/extensionRegistry';
import { clearLayerPanelStates } from './layerPanelState';
import { createWorkbenchPersistenceRuntime } from './persistenceRuntime';
import { createOpenProjectBroker } from './projects/openProjectBroker';
import { collectHeldAssetRefs, partitionHeldAssetNames } from './projects/projectAssets';
import { describeRefusedProjects } from './projects/projectLoadRefusal';
import {
  createSyncedWorkbenchPersistence,
  type SyncedWorkbenchPersistence,
  type WorkbenchLoadOptions,
} from './projects/syncedPersistence';
import { consumeWorkspaceClearFailure } from './settings/clearWorkspaceData';
import { getProjectWidgetValues } from './widgetState';
import { createWorkbenchStore, type WorkbenchSnapshot, type WorkbenchInternalStore } from './workbenchStore';

interface WorkbenchContextValue {
  activeProject: Project;
  /** Queue side effects must wait for hydration to avoid acting on state about to be replaced. */
  hasHydrated: boolean;
}

type EqualityFn<T> = (left: T, right: T) => boolean;
type WorkbenchSelector<T> = (snapshot: WorkbenchSnapshot) => T;

const WorkbenchStoreContext = createContext<WorkbenchInternalStore | null>(null);
const WorkbenchPersistenceContext = createContext<SyncedWorkbenchPersistence | null>(null);
const WorkbenchExtensionsContext = createContext<ExtensionRegistry | null>(null);
const subscribeToNothing = (): (() => void) => () => {};
const getNullSnapshot = (): null => null;

export const shallowEqual = selectorShallowEqual;

type GetCanvasHeldAssetRefs = (
  projectId: string
) => { images: readonly string[]; videos: readonly string[] } | undefined;

/** An open editor keeps its unsaved and undo media protected while the tab is alive. */
export const startBrowserIntermediateHold = (
  store: WorkbenchInternalStore,
  owner: AccountScope,
  getCanvasHeldAssetRefs: GetCanvasHeldAssetRefs
): (() => void) => {
  const leaseId = createUuid();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let pending = false;
  let pendingRefresh = false;
  const leaseSignatures: [string[], string[]] = [[], []];
  let activeSlot: 0 | 1 | null = null;
  let lastProjects = store.getSnapshot().projects;
  // Project snapshots are immutable; reuse each open project's scan until its object changes.
  const projectRefs = new Map<string, { project: Project; refs: ReturnType<typeof collectHeldAssetRefs> }>();

  const releaseSlot = async (slot: 0 | 1, from = 0): Promise<void> => {
    const signatures = leaseSignatures[slot];
    for (let index = from; index < signatures.length; index += 1) {
      if (!signatures[index] || disposed || owner.signal.aborted) {
        continue;
      }
      try {
        await apiFetch(`/api/v1/intermediates/holds/${encodeURIComponent(`${leaseId}-${slot}-${index}`)}`, {
          method: 'DELETE',
          signal: owner.signal,
        });
        signatures[index] = '';
      } catch {
        // Keep the signature so a later send can retry releasing this lease.
      }
    }
    while (signatures.at(-1) === '') {
      signatures.pop();
    }
  };

  const putBatch = async (
    slot: 0 | 1,
    index: number,
    batch: { images: string[]; videos: string[] }
  ): Promise<boolean> => {
    if (disposed || owner.signal.aborted) {
      return false;
    }
    try {
      await apiFetch(`/api/v1/intermediates/holds/${encodeURIComponent(`${leaseId}-${slot}-${index}`)}`, {
        body: JSON.stringify(batch),
        headers: { 'Content-Type': 'application/json' },
        method: 'PUT',
        signal: owner.signal,
      });
      leaseSignatures[slot][index] = JSON.stringify([batch.images, batch.videos]);
      return true;
    } catch {
      return false;
    }
  };

  const send = async (refresh = false): Promise<void> => {
    if (disposed || owner.signal.aborted) {
      return;
    }
    if (inFlight) {
      pending = true;
      pendingRefresh ||= refresh;
      return;
    }
    inFlight = true;
    try {
      do {
        pending = false;
        const projects = store.getSnapshot().projects;
        const refs = { images: new Set<string>(), videos: new Set<string>() };
        const openProjectIds = new Set<string>();
        for (const project of projects) {
          openProjectIds.add(project.id);
          const cached = projectRefs.get(project.id);
          const projectAssets = cached?.project === project ? cached.refs : collectHeldAssetRefs([project]);
          if (cached?.project !== project) {
            projectRefs.set(project.id, { project, refs: projectAssets });
          }
          projectAssets.images.forEach((name) => refs.images.add(name));
          projectAssets.videos.forEach((name) => refs.videos.add(name));
          const retained = getCanvasHeldAssetRefs(project.id);
          retained?.images.forEach((name) => refs.images.add(name));
          retained?.videos.forEach((name) => refs.videos.add(name));
        }
        for (const projectId of projectRefs.keys()) {
          if (!openProjectIds.has(projectId)) {
            projectRefs.delete(projectId);
          }
        }
        const images = [...refs.images].sort();
        const videos = [...refs.videos].sort();
        const mustRefresh = refresh || pendingRefresh;
        refresh = false;
        pendingRefresh = false;
        if (!images.length && !videos.length) {
          await releaseSlot(0);
          await releaseSlot(1);
          activeSlot = null;
          continue;
        }
        const batches = partitionHeldAssetNames(images, videos);
        const signatures = batches.map((batch) => JSON.stringify([batch.images, batch.videos]));
        const current = activeSlot === null ? null : leaseSignatures[activeSlot];
        let trimActive = false;
        if (
          current &&
          current.length === signatures.length &&
          signatures.every((value, index) => value === current[index])
        ) {
          if (mustRefresh) {
            for (let index = 0; index < batches.length; index += 1) {
              await putBatch(activeSlot!, index, batches[index]!);
            }
          }
          trimActive = true;
        } else {
          // Stage all replacement batches under the other lease set. Old names stay protected
          // even when sorting moves them across the per-request batch boundary.
          const nextSlot: 0 | 1 = activeSlot === 0 ? 1 : 0;
          let staged = true;
          for (let index = 0; index < batches.length; index += 1) {
            staged = (await putBatch(nextSlot, index, batches[index]!)) && staged;
          }
          if (staged && !disposed && !owner.signal.aborted) {
            const oldSlot = activeSlot;
            activeSlot = nextSlot;
            trimActive = true;
            if (oldSlot !== null) {
              await releaseSlot(oldSlot);
            }
          }
        }
        if (activeSlot !== null) {
          if (trimActive) {
            await releaseSlot(activeSlot, batches.length);
          }
          await releaseSlot(activeSlot === 0 ? 1 : 0);
        }
        if (disposed || owner.signal.aborted) {
          break;
        }
      } while (pending);
    } finally {
      inFlight = false;
    }
  };
  const schedule = (): void => {
    const projects = store.getSnapshot().projects;
    if (projects === lastProjects) {
      return;
    }
    lastProjects = projects;
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      void send();
    }, 250);
  };
  const unsubscribe = store.subscribe(schedule);
  const heartbeat = setInterval(() => void send(true), 5 * 60_000);
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') {
      void send(true);
    }
  };
  document.addEventListener('visibilitychange', onVisible);
  void send();
  return () => {
    disposed = true;
    unsubscribe();
    clearInterval(heartbeat);
    document.removeEventListener('visibilitychange', onVisible);
    if (timer !== null) {
      clearTimeout(timer);
    }
  };
};

export const WorkbenchProvider = ({
  children,
  getCanvasHeldAssetRefs,
  loadOptions,
}: {
  children: ReactNode;
  getCanvasHeldAssetRefs: GetCanvasHeldAssetRefs;
  /** Boot-time session options (deep-linked project, fresh draft). Read once at mount. */
  loadOptions?: WorkbenchLoadOptions;
}) => {
  const [store] = useState(() => createWorkbenchStore());
  const [owner] = useState(captureAccountScope);
  const { t } = useTranslation();
  const [persistence] = useState(() => createSyncedWorkbenchPersistence(owner));
  const [extensions] = useState(createExtensionRegistry);
  const [loadUnavailable, setLoadUnavailable] = useState<{ message: string; retry(): void } | null>(null);
  const hasHydrated = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).hasHydrated;

  // The runtime is created inside the effect: disposal is terminal, so each
  // mount (including a StrictMode remount) must get its own instance.
  useMountEffect(() => {
    const releasePersistence = persistence.retain();
    const persistenceRuntime = createWorkbenchPersistenceRuntime({
      aggregate: {
        ...store.internal.persistence,
        getPersistedRevision: store.getPersistedRevision,
        notifyProjectNotFound: () =>
          store.commands.notifications.add({
            kind: 'info',
            message: 'The linked project does not exist on this account — it may have been deleted.',
            title: 'Project not found',
          }),
        reportLoadAvailable: () => {
          setLoadUnavailable(null);
          const clearFailure = consumeWorkspaceClearFailure(window.sessionStorage);
          if (clearFailure) {
            store.commands.notifications.reportError({
              area: 'workspace-clear',
              message: clearFailure,
              namespace: 'system',
            });
          }
        },
        reportLoadError: (message) =>
          store.commands.notifications.reportError({ area: 'persistence-load', message, namespace: 'system' }),
        reportLoadUnavailable: (message) =>
          setLoadUnavailable({ message, retry: () => persistenceRuntime.retryLoad() }),
        reportRefusedProjects: (refused) => {
          const notice = describeRefusedProjects(refused, t);

          if (notice) {
            store.commands.notifications.add({ kind: 'info', ...notice });
          }
        },
        setHasHydrated: store.setHasHydrated,
        subscribe: store.subscribe,
      },
      loadOptions,
      persistence,
      signal: owner.signal,
    });
    // Publish throughout the mount so sibling library surfaces mutate open projects through the sync engine.
    const openProjectBroker = createOpenProjectBroker({
      closeProject: (projectId) => {
        // Skip close's last-tab refusal during deletion; leaveEditorIfLast owns leaving the editor.
        if (store.getSnapshot().projects.length > 1) {
          store.commands.projects.close(projectId);
        }
      },
      deleteProject: (projectId) => persistence.deleteProjectOnServer(projectId),
      flushProject: (projectId) => {
        const project = store.getSnapshot().projects.find((candidate) => candidate.id === projectId);

        // Unopened projects have no local edits; their ids reflect server acknowledgements.
        return project
          ? persistence.flushProjectToServer(project)
          : Promise.resolve<ProjectPushOutcome>({ documentJson: '', kind: 'acknowledged' });
      },
      getOpenProjectIds: () => store.getSnapshot().projects.map((project) => project.id),
      markProjectDeleted: (projectId) => {
        persistence.markProjectDeleted(projectId);
      },
      renameProject: (projectId, name) => {
        store.commands.projects.rename(projectId, name);
      },
      subscribe: store.subscribe,
      unmarkProjectDeleted: (projectId) => {
        persistence.unmarkProjectDeleted(projectId);
      },
    });

    persistenceRuntime.start();
    const releaseIntermediateHold = startBrowserIntermediateHold(store, owner, getCanvasHeldAssetRefs);

    return () => {
      releaseIntermediateHold();
      clearLayerPanelStates();
      openProjectBroker.dispose();
      persistenceRuntime.dispose();
      releasePersistence();
    };
  });

  return (
    <WorkbenchPersistenceContext value={persistence}>
      <WorkbenchExtensionsContext value={extensions}>
        <WorkbenchStoreContext value={store}>
          {loadUnavailable ? (
            <WorkbenchUnavailableScreen
              message={loadUnavailable.message}
              onRetry={loadUnavailable.retry}
              persistence={persistence}
            />
          ) : hasHydrated ? (
            children
          ) : (
            <WorkbenchSplashScreen messageKey="splash.openingProject" />
          )}
        </WorkbenchStoreContext>
      </WorkbenchExtensionsContext>
    </WorkbenchPersistenceContext>
  );
};

const useWorkbenchStore = (): WorkbenchInternalStore => {
  const store = use(WorkbenchStoreContext);

  if (!store) {
    throw new Error('useWorkbenchStore must be used within a WorkbenchProvider.');
  }

  return store;
};

const useOptionalWorkbenchStore = (): WorkbenchInternalStore | null => use(WorkbenchStoreContext);

/** Privileged aggregate adapter for persistence and resource-owning runtimes only. */
export const useWorkbenchInternalStore = (): WorkbenchInternalStore => useWorkbenchStore();

export const useHasWorkbenchProvider = (): boolean => useOptionalWorkbenchStore() !== null;

export const useWorkbenchSelector = <Selected,>(
  selector: WorkbenchSelector<Selected>,
  isEqual: EqualityFn<Selected> = shallowEqual
): Selected => {
  const store = useWorkbenchStore();

  return useExternalStoreSelector(store.subscribe, store.getSnapshot, selector, isEqual);
};

export const useDebouncedWorkbenchSelector = <Selected,>(
  selector: WorkbenchSelector<Selected>,
  debounceMs = 300,
  isEqual: EqualityFn<Selected> = Object.is
): Selected => {
  const liveSelection = useWorkbenchSelector(selector, isEqual);
  const [selection, setSelection] = useState(liveSelection);

  useEffect(() => {
    if (isEqual(selection, liveSelection)) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setSelection(liveSelection);
    }, debounceMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [debounceMs, isEqual, liveSelection, selection]);

  return selection;
};

export const useActiveProject = (): Project => useWorkbenchSelector((snapshot) => snapshot.activeProject);

export const useActiveProjectSelector = <Selected,>(
  selector: (project: Project) => Selected,
  isEqual?: EqualityFn<Selected>
): Selected => useWorkbenchSelector((snapshot) => selector(snapshot.activeProject), isEqual);

export const useActiveProjectId = (): string => useWorkbenchSelector((snapshot) => snapshot.activeProject.id);

export const useActiveProjectName = (): string => useActiveProjectSelector((project) => project.name);

export const useActiveProjectLayoutSelector = <Selected,>(
  selector: (layout: ProjectLayoutState) => Selected,
  isEqual?: EqualityFn<Selected>
): Selected => useActiveProjectSelector((project) => selector(project.layout), isEqual);

export const useActiveProjectSettingsSelector = <Selected,>(
  selector: (settings: ProjectSettings) => Selected,
  isEqual?: EqualityFn<Selected>
): Selected => useActiveProjectSelector((project) => selector(project.settings), isEqual);

export const useWidgetValuesSelector = <Selected,>(
  widgetId: WidgetTypeId,
  selector: (values: Record<string, unknown>) => Selected,
  isEqual?: EqualityFn<Selected>
): Selected => useActiveProjectSelector((project) => selector(getProjectWidgetValues(project, widgetId)), isEqual);

export const useWidgetInstanceValuesSelector = <Selected,>(
  instanceId: WidgetInstanceId,
  selector: (values: Record<string, unknown>) => Selected,
  isEqual?: EqualityFn<Selected>
): Selected =>
  useActiveProjectSelector((project) => selector(project.widgetInstances[instanceId]?.state.values ?? {}), isEqual);

export const useProjectWidgetInstanceValuesSelector = <Selected,>(
  projectId: string,
  instanceId: WidgetInstanceId,
  selector: (values: Record<string, unknown>) => Selected,
  isEqual?: EqualityFn<Selected>
): Selected =>
  useWorkbenchSelector((snapshot) => {
    const project = snapshot.projects.find((candidate) => candidate.id === projectId);

    return selector(project?.widgetInstances[instanceId]?.state.values ?? {});
  }, isEqual);

export const useWorkbenchHasHydrated = (): boolean => useWorkbenchSelector((snapshot) => snapshot.hasHydrated);

/** Stable intent-oriented aggregate commands; callers never receive reducer actions. */
export const useWorkbenchCommands = () => useWorkbenchStore().commands;

export const useWorkbenchQueries = () => useWorkbenchStore().queries;

/** Stable read-model subscription used by external runtime adapters. */
export const useWorkbenchSubscription = () => useWorkbenchStore().subscribe;

/** Privileged persistence read/write port; this is the only UI-adjacent full-state adapter. */
export const useWorkbenchPersistenceAdapter = () => useWorkbenchStore().internal.persistence;

export const useWorkbenchPersistenceService = (): SyncedWorkbenchPersistence => {
  const persistence = use(WorkbenchPersistenceContext);
  if (!persistence) {
    throw new Error('useWorkbenchPersistenceService must be used within a WorkbenchProvider.');
  }
  return persistence;
};

export const useOptionalWorkbenchPersistenceService = (): SyncedWorkbenchPersistence | null =>
  use(WorkbenchPersistenceContext);

export const useWorkbenchExtensions = (): ExtensionRegistry => {
  const extensions = use(WorkbenchExtensionsContext);
  if (!extensions) {
    throw new Error('useWorkbenchExtensions must be used within a WorkbenchProvider.');
  }
  return extensions;
};

export const useOptionalWorkbenchExtensions = (): ExtensionRegistry | null => use(WorkbenchExtensionsContext);

export const useOptionalWorkbenchCommands = () => useOptionalWorkbenchStore()?.commands ?? null;

export const useOptionalWorkbenchQueries = () => useOptionalWorkbenchStore()?.queries ?? null;

export const useOptionalWorkbenchSelector = <Selected,>(
  selector: WorkbenchSelector<Selected>,
  fallback: Selected,
  isEqual: EqualityFn<Selected> = shallowEqual
): Selected => {
  const store = useOptionalWorkbenchStore();

  return useExternalStoreSelector(
    store?.subscribe ?? subscribeToNothing,
    store?.getSnapshot ?? getNullSnapshot,
    (snapshot) => (snapshot ? selector(snapshot) : fallback),
    isEqual
  );
};

export const useWorkbench = (): WorkbenchContextValue => {
  const store = useWorkbenchStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return snapshot;
};

export const useOptionalWorkbench = (): WorkbenchContextValue | null => {
  const store = useOptionalWorkbenchStore();
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? subscribeToNothing,
    store?.getSnapshot ?? getNullSnapshot,
    store?.getSnapshot ?? getNullSnapshot
  );

  return store && snapshot ? snapshot : null;
};
