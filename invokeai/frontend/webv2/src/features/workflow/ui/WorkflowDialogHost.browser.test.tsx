import type { ProjectGraphState } from '@features/workflow/core/types';

import { ChakraProvider } from '@chakra-ui/react';
import { createProjectGraph } from '@features/workflow/utility';
import { accountLifecycle } from '@platform/state/accountLifecycle';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { system } from '@theme/system';
import { act, Profiler, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowUiAdapter } from './WorkflowUiContext';

import { workflowLibrarySyncStore } from './library/workflowLibrarySyncStore';
import { WorkflowUiProvider } from './WorkflowUiContext';
import { WorkflowDialogHost } from './WorkflowWidgetChrome';

const deferred = <T,>() => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
};

// The dialogs pull in heavy leaf UI (node search, the library browser, graph
// previews) that is irrelevant to the autosave wiring under test here; stub
// them out so this stays a focused wiring-layer test.
vi.mock('./editor/AddNodeDialog', () => ({ AddNodeDialog: () => null }));
vi.mock('./library/WorkflowLibraryDialog', () => ({ WorkflowLibraryDialog: () => null }));
vi.mock('./PendingLibraryWorkflowLoader', () => ({ PendingWorkflowLoader: () => null }));

import { onWorkflowLibraryCacheInvalidated } from '@features/workflow/queries';

const { updateLibraryWorkflowMock } = vi.hoisted(() => ({ updateLibraryWorkflowMock: vi.fn() }));

vi.mock('@features/workflow/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateLibraryWorkflow: updateLibraryWorkflowMock,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const createMutablePort = <Snapshot,>(initialSnapshot: Snapshot) => {
  let snapshot = initialSnapshot;
  const listeners = new Set<() => void>();
  return {
    port: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    setSnapshot: (next: Snapshot) => {
      snapshot = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
};

const createGraphWithDuplicateWorkflowReturns = (): ProjectGraphState => ({
  ...createProjectGraph('workflow-1'),
  libraryWorkflowId: 'library-workflow-1',
  nodes: [
    { data: { type: 'workflow_return' }, id: 'return-1', position: { x: 0, y: 0 }, type: 'invocation' },
    { data: { type: 'workflow_return' }, id: 'return-2', position: { x: 100, y: 0 }, type: 'invocation' },
  ] as unknown as ProjectGraphState['nodes'],
});

/**
 * Regression coverage for the StrictMode autosaver-disposal bug: the
 * autosaver used to be created once via a `useState` initializer and
 * disposed in a separate effect's cleanup. React StrictMode's dev-only
 * mount→cleanup→mount simulation ran that cleanup without ever re-running
 * the initializer (state is preserved across the simulation, effects are
 * not), permanently disposing the one live instance — autosave then
 * silently no-oped for the rest of the session. The fix creates AND
 * disposes the autosaver within a single mount effect (held in a ref), so
 * the simulation produces a fresh, live instance instead. Mounting under a
 * real `<StrictMode>` here reproduces that simulation; a test that mounted
 * without it would not have caught the bug.
 */
describe('WorkflowDialogHost library autosave under StrictMode', () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    queryClient = new QueryClient();
    updateLibraryWorkflowMock.mockReset();
    updateLibraryWorkflowMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    queryClient.clear();
    host.remove();
  });

  it('still autosaves a bound workflow after a graph edit', async () => {
    const cacheInvalidated = vi.fn();
    const stopListening = onWorkflowLibraryCacheInvalidated(cacheInvalidated);

    const boundGraph = { ...createProjectGraph('workflow-1'), libraryWorkflowId: 'library-workflow-1' };
    const project = createMutablePort({
      galleryValues: {},
      id: 'project-1',
      isWorkflowRunning: false,
      projectGraph: boundGraph,
      workflowValues: {},
    });

    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- intentionally stable for this render lifetime
    const adapter = {
      commands: {
        bindLibraryWorkflow: vi.fn(),
        editGraph: vi.fn(),
        redo: vi.fn(),
        replace: vi.fn(),
        undo: vi.fn(),
      },
      getProjectGraph: () => project.port.getSnapshot().projectGraph,
      notifications: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
      project: project.port,
      widgets: { open: vi.fn(), patchValues: vi.fn() },
    } as unknown as WorkflowUiAdapter;

    root = createRoot(host);

    await act(() => {
      root.render(
        <StrictMode>
          <ChakraProvider value={system}>
            <QueryClientProvider client={queryClient}>
              <WorkflowUiProvider adapter={adapter}>
                <WorkflowDialogHost />
              </WorkflowUiProvider>
            </QueryClientProvider>
          </ChakraProvider>
        </StrictMode>
      );
    });

    expect(updateLibraryWorkflowMock).not.toHaveBeenCalled();

    // A graph edit on the already-bound project: a new object identity so the
    // dialog host's graph-changed effect fires and schedules the debounced
    // autosave.
    await act(() => {
      project.setSnapshot({
        ...project.port.getSnapshot(),
        projectGraph: { ...boundGraph, name: 'Edited name' },
      });
    });

    // Past the 2s debounce.
    await act(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 2100);
        })
    );
    // Let the autosaver's save promise settle.
    await act(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        })
    );

    expect(updateLibraryWorkflowMock).toHaveBeenCalledTimes(1);
    expect(updateLibraryWorkflowMock).toHaveBeenCalledWith(
      'library-workflow-1',
      expect.objectContaining({ name: 'Edited name' }),
      expect.any(AbortSignal)
    );
    // The library dialog must not keep serving the pre-save payload.
    expect(cacheInvalidated).toHaveBeenCalledTimes(1);
    stopListening();
  });

  it('rejects an autosave when the graph has duplicate workflow returns', async () => {
    const boundGraph = createGraphWithDuplicateWorkflowReturns();
    const project = createMutablePort({
      galleryValues: {},
      id: 'project-1',
      isWorkflowRunning: false,
      projectGraph: boundGraph,
      workflowValues: {},
    });
    const notifications = { error: vi.fn(), info: vi.fn(), success: vi.fn() };

    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- intentionally stable for this render lifetime
    const adapter = {
      commands: {
        bindLibraryWorkflow: vi.fn(),
        editGraph: vi.fn(),
        redo: vi.fn(),
        replace: vi.fn(),
        undo: vi.fn(),
      },
      getProjectGraph: () => project.port.getSnapshot().projectGraph,
      notifications,
      project: project.port,
      widgets: { open: vi.fn(), patchValues: vi.fn() },
    } as unknown as WorkflowUiAdapter;

    root = createRoot(host);

    await act(() => {
      root.render(
        <StrictMode>
          <ChakraProvider value={system}>
            <QueryClientProvider client={queryClient}>
              <WorkflowUiProvider adapter={adapter}>
                <WorkflowDialogHost />
              </WorkflowUiProvider>
            </QueryClientProvider>
          </ChakraProvider>
        </StrictMode>
      );
    });

    await act(() => {
      project.setSnapshot({
        ...project.port.getSnapshot(),
        projectGraph: { ...boundGraph, name: 'Invalid duplicate-return edit' },
      });
    });
    await act(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 2100);
        })
    );

    expect(updateLibraryWorkflowMock).not.toHaveBeenCalled();
    expect(notifications.error).toHaveBeenCalledTimes(1);
  });

  it('does not repeat the duplicate-return autosave notification for every edit', async () => {
    const boundGraph = createGraphWithDuplicateWorkflowReturns();
    const project = createMutablePort({
      galleryValues: {},
      id: 'project-1',
      isWorkflowRunning: false,
      projectGraph: boundGraph,
      workflowValues: {},
    });
    const notifications = { error: vi.fn(), info: vi.fn(), success: vi.fn() };

    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- intentionally stable for this render lifetime
    const adapter = {
      commands: {
        bindLibraryWorkflow: vi.fn(),
        editGraph: vi.fn(),
        redo: vi.fn(),
        replace: vi.fn(),
        undo: vi.fn(),
      },
      getProjectGraph: () => project.port.getSnapshot().projectGraph,
      notifications,
      project: project.port,
      widgets: { open: vi.fn(), patchValues: vi.fn() },
    } as unknown as WorkflowUiAdapter;

    root = createRoot(host);

    await act(() => {
      root.render(
        <StrictMode>
          <ChakraProvider value={system}>
            <QueryClientProvider client={queryClient}>
              <WorkflowUiProvider adapter={adapter}>
                <WorkflowDialogHost />
              </WorkflowUiProvider>
            </QueryClientProvider>
          </ChakraProvider>
        </StrictMode>
      );
    });

    const editAndWaitForAutosave = async (name: string) => {
      await act(() => {
        project.setSnapshot({
          ...project.port.getSnapshot(),
          projectGraph: { ...boundGraph, name },
        });
      });
      await act(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 2100);
          })
      );
    };

    await editAndWaitForAutosave('First invalid edit');
    await editAndWaitForAutosave('Second invalid edit');

    expect(notifications.error).toHaveBeenCalledTimes(1);
    expect(updateLibraryWorkflowMock).not.toHaveBeenCalled();
  });

  it('does not notify when disposing a pending duplicate-return autosave', async () => {
    const boundGraph = createGraphWithDuplicateWorkflowReturns();
    const project = createMutablePort({
      galleryValues: {},
      id: 'project-1',
      isWorkflowRunning: false,
      projectGraph: boundGraph,
      workflowValues: {},
    });
    const notifications = { error: vi.fn(), info: vi.fn(), success: vi.fn() };

    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- intentionally stable for this render lifetime
    const adapter = {
      commands: {
        bindLibraryWorkflow: vi.fn(),
        editGraph: vi.fn(),
        redo: vi.fn(),
        replace: vi.fn(),
        undo: vi.fn(),
      },
      getProjectGraph: () => project.port.getSnapshot().projectGraph,
      notifications,
      project: project.port,
      widgets: { open: vi.fn(), patchValues: vi.fn() },
    } as unknown as WorkflowUiAdapter;

    root = createRoot(host);

    await act(() => {
      root.render(
        <StrictMode>
          <ChakraProvider value={system}>
            <QueryClientProvider client={queryClient}>
              <WorkflowUiProvider adapter={adapter}>
                <WorkflowDialogHost />
              </WorkflowUiProvider>
            </QueryClientProvider>
          </ChakraProvider>
        </StrictMode>
      );
    });

    await act(() => {
      project.setSnapshot({
        ...project.port.getSnapshot(),
        projectGraph: { ...boundGraph, name: 'Pending invalid edit' },
      });
    });
    await act(() => root.render(null));

    expect(notifications.error).not.toHaveBeenCalled();
    expect(updateLibraryWorkflowMock).not.toHaveBeenCalled();
  });

  it('re-arms duplicate-return notifications after valid saves and deduped reverts', async () => {
    const boundGraph = createGraphWithDuplicateWorkflowReturns();
    const validGraph = { ...createProjectGraph('workflow-1'), libraryWorkflowId: 'library-workflow-1' };
    const project = createMutablePort({
      galleryValues: {},
      id: 'project-1',
      isWorkflowRunning: false,
      projectGraph: boundGraph,
      workflowValues: {},
    });
    const notifications = { error: vi.fn(), info: vi.fn(), success: vi.fn() };

    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- intentionally stable for this render lifetime
    const adapter = {
      commands: {
        bindLibraryWorkflow: vi.fn(),
        editGraph: vi.fn(),
        redo: vi.fn(),
        replace: vi.fn(),
        undo: vi.fn(),
      },
      getProjectGraph: () => project.port.getSnapshot().projectGraph,
      notifications,
      project: project.port,
      widgets: { open: vi.fn(), patchValues: vi.fn() },
    } as unknown as WorkflowUiAdapter;

    root = createRoot(host);

    await act(() => {
      root.render(
        <StrictMode>
          <ChakraProvider value={system}>
            <QueryClientProvider client={queryClient}>
              <WorkflowUiProvider adapter={adapter}>
                <WorkflowDialogHost />
              </WorkflowUiProvider>
            </QueryClientProvider>
          </ChakraProvider>
        </StrictMode>
      );
    });

    const waitForAutosave = async () => {
      await act(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 2100);
          })
      );
    };

    await act(() => {
      project.setSnapshot({ ...project.port.getSnapshot(), projectGraph: { ...boundGraph, name: 'Invalid edit' } });
    });
    await waitForAutosave();

    await act(() => {
      project.setSnapshot({ ...project.port.getSnapshot(), projectGraph: validGraph });
    });
    await waitForAutosave();

    await act(() => {
      project.setSnapshot({ ...project.port.getSnapshot(), projectGraph: { ...boundGraph, name: 'Invalid again' } });
    });
    await waitForAutosave();

    expect(notifications.error).toHaveBeenCalledTimes(2);

    await act(() => {
      project.setSnapshot({ ...project.port.getSnapshot(), projectGraph: validGraph });
    });
    await waitForAutosave();

    await act(() => {
      project.setSnapshot({
        ...project.port.getSnapshot(),
        projectGraph: { ...boundGraph, name: 'Invalid after revert' },
      });
    });
    await waitForAutosave();

    expect(notifications.error).toHaveBeenCalledTimes(3);
    expect(updateLibraryWorkflowMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The host used to learn about graph edits through a selector
   * (`useWorkflowProjectSelector`) feeding a change-detecting effect, which
   * re-rendered this component on every graph edit just to notice the
   * autosaver should be poked. Edits reach the project store through
   * imperative commands, not through this component's own props or state, so
   * there is nothing here that needs re-rendering to learn about them — a
   * direct store subscription (held in the same mount effect that owns the
   * autosaver) can notify the autosaver without forcing React back through
   * this component's render.
   */
  it('schedules an autosave for graph edits made outside React renders', async () => {
    workflowLibrarySyncStore.setSnapshot({ status: 'idle' });

    const boundGraph = { ...createProjectGraph('workflow-1'), libraryWorkflowId: 'library-workflow-1' };
    const project = createMutablePort({
      galleryValues: {},
      id: 'project-1',
      isWorkflowRunning: false,
      projectGraph: boundGraph,
      workflowValues: {},
    });

    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- intentionally stable for this render lifetime
    const adapter = {
      commands: {
        bindLibraryWorkflow: vi.fn(),
        editGraph: vi.fn(),
        redo: vi.fn(),
        replace: vi.fn(),
        undo: vi.fn(),
      },
      getProjectGraph: () => project.port.getSnapshot().projectGraph,
      notifications: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
      project: project.port,
      widgets: { open: vi.fn(), patchValues: vi.fn() },
    } as unknown as WorkflowUiAdapter;

    root = createRoot(host);

    let renderCount = 0;
    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test-only render probe, not app code
    const countRender = () => {
      renderCount += 1;
    };

    await act(() => {
      root.render(
        <StrictMode>
          <ChakraProvider value={system}>
            <QueryClientProvider client={queryClient}>
              <WorkflowUiProvider adapter={adapter}>
                <Profiler id="dialog-host" onRender={countRender}>
                  <WorkflowDialogHost />
                </Profiler>
              </WorkflowUiProvider>
            </QueryClientProvider>
          </ChakraProvider>
        </StrictMode>
      );
    });

    // Only the edit dispatched below is under test; the mount itself renders
    // (StrictMode doubles it).
    renderCount = 0;

    // Dispatch a graph edit straight through the project store — the same
    // path an imperative command handler uses — rather than through a prop
    // that would force this component to re-render.
    await act(() => {
      project.setSnapshot({
        ...project.port.getSnapshot(),
        projectGraph: { ...boundGraph, name: 'Edited outside React' },
      });
    });

    expect(renderCount).toBe(0);
    expect(workflowLibrarySyncStore.getSnapshot().status).toBe('dirty');
  });

  /**
   * Account rotation (`accountLifecycle.activate`/`.invalidate`) aborts the
   * signal a save started under and synchronously resets
   * `workflowLibrarySyncStore` to 'idle' (it is an account-owned resource,
   * cleared by `clearResources()` inside `rotateScope`) — but the aborted
   * write's rejection lands a tick later, after that reset. A save's own
   * `assertAccountScopeCurrent` throw (which turns a late resolution into a
   * rejection so a stale write never gets treated as successful) is not
   * enough by itself: `runSave()`'s `.catch` still calls `onStatus('error')`
   * unconditionally, and without a scope guard on that callback the late
   * write would land 'error' in the *next* account's store. Modeled on the
   * account-rotation tests in `useScopedAction.browser.test.tsx`, which use
   * the real `accountLifecycle` singleton directly.
   */
  it('does not park a stale save error in the sync store after an account switch', async () => {
    const boundGraph = { ...createProjectGraph('workflow-1'), libraryWorkflowId: 'library-workflow-1' };
    const project = createMutablePort({
      galleryValues: {},
      id: 'project-1',
      isWorkflowRunning: false,
      projectGraph: boundGraph,
      workflowValues: {},
    });

    const request = deferred<void>();

    updateLibraryWorkflowMock.mockReturnValue(request.promise);

    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- intentionally stable for this render lifetime
    const adapter = {
      commands: {
        bindLibraryWorkflow: vi.fn(),
        editGraph: vi.fn(),
        redo: vi.fn(),
        replace: vi.fn(),
        undo: vi.fn(),
      },
      getProjectGraph: () => project.port.getSnapshot().projectGraph,
      notifications: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
      project: project.port,
      widgets: { open: vi.fn(), patchValues: vi.fn() },
    } as unknown as WorkflowUiAdapter;

    root = createRoot(host);

    await act(() => {
      root.render(
        <StrictMode>
          <ChakraProvider value={system}>
            <QueryClientProvider client={queryClient}>
              <WorkflowUiProvider adapter={adapter}>
                <WorkflowDialogHost />
              </WorkflowUiProvider>
            </QueryClientProvider>
          </ChakraProvider>
        </StrictMode>
      );
    });

    await act(() => {
      project.setSnapshot({
        ...project.port.getSnapshot(),
        projectGraph: { ...boundGraph, name: 'Edited before switch' },
      });
    });

    // Past the debounce: the save has started (captured the pre-switch
    // account scope) and is now awaiting the still-pending request below.
    await act(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 2100);
        })
    );

    expect(updateLibraryWorkflowMock).toHaveBeenCalledTimes(1);

    try {
      // Switch accounts mid-flight: aborts the pre-switch scope's signal and
      // synchronously resets the sync store to 'idle' via clearResources().
      accountLifecycle.activate('workflow-dialog-host-test-account', ':user:workflow-dialog-host-test-account');

      expect(workflowLibrarySyncStore.getSnapshot().status).toBe('idle');

      // The deferred request settles after the switch — the same lag as an
      // in-flight fetch whose abort rejection arrives after the synchronous
      // store reset. Resolving (rather than rejecting) exercises the path
      // the review flagged: `assertAccountScopeCurrent` turns this into a
      // rejection inside `save()`, so a stale write is never mistaken for a
      // successful one.
      await act(async () => {
        request.resolve();
        await request.promise.catch(() => undefined);
        // Give the save's `.then`/`.catch` continuation a turn to run.
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(workflowLibrarySyncStore.getSnapshot().status).toBe('idle');
    } finally {
      accountLifecycle.invalidate();
    }
  });

  it('does not flush a pending old-account edit after the account switches', async () => {
    const boundGraph = { ...createProjectGraph('workflow-1'), libraryWorkflowId: 'library-workflow-1' };
    const project = createMutablePort({
      galleryValues: {},
      id: 'project-1',
      isWorkflowRunning: false,
      projectGraph: boundGraph,
      workflowValues: {},
    });
    const notifications = { error: vi.fn(), info: vi.fn(), success: vi.fn() };

    accountLifecycle.activate('workflow-dialog-host-old-account', ':user:workflow-dialog-host-old-account');

    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- intentionally stable for this render lifetime
    const adapter = {
      commands: {
        bindLibraryWorkflow: vi.fn(),
        editGraph: vi.fn(),
        redo: vi.fn(),
        replace: vi.fn(),
        undo: vi.fn(),
      },
      getProjectGraph: () => project.port.getSnapshot().projectGraph,
      notifications,
      project: project.port,
      widgets: { open: vi.fn(), patchValues: vi.fn() },
    } as unknown as WorkflowUiAdapter;

    root = createRoot(host);

    try {
      await act(() => {
        root.render(
          <StrictMode>
            <ChakraProvider value={system}>
              <QueryClientProvider client={queryClient}>
                <WorkflowUiProvider adapter={adapter}>
                  <WorkflowDialogHost />
                </WorkflowUiProvider>
              </QueryClientProvider>
            </ChakraProvider>
          </StrictMode>
        );
      });

      await act(() => {
        project.setSnapshot({
          ...project.port.getSnapshot(),
          projectGraph: { ...boundGraph, name: 'Old account edit' },
        });
      });

      accountLifecycle.activate('workflow-dialog-host-new-account', ':user:workflow-dialog-host-new-account');
      await act(() => root.render(null));
      await Promise.resolve();

      expect(updateLibraryWorkflowMock).not.toHaveBeenCalled();
    } finally {
      accountLifecycle.invalidate();
    }
  });
});
