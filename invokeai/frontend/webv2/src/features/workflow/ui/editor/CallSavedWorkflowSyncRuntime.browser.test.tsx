import type { ProjectGraphState, WorkflowNode } from '@features/workflow/core/types';
import type { WorkflowUiAdapter } from '@features/workflow/ui/WorkflowUiContext';
import type { ProjectGraphAction } from '@features/workflow/utility';

import { createProjectGraph, projectGraphReducer } from '@features/workflow/utility';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getLibraryWorkflowRecordMock } = vi.hoisted(() => ({ getLibraryWorkflowRecordMock: vi.fn() }));

vi.mock('@features/workflow/data/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLibraryWorkflowRecord: getLibraryWorkflowRecordMock,
}));

// The reconciler only needs a loaded snapshot to run; the child record never
// arrives in these tests, so the template contents are never read.
vi.mock('@features/workflow/data/templates', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getInvocationTemplatesSnapshot: () => ({ error: null, status: 'loaded', templates: {} }),
  subscribeInvocationTemplates: () => () => undefined,
}));

import { WorkflowUiProvider } from '@features/workflow/ui/WorkflowUiContext';

import { CallSavedWorkflowSyncRuntime } from './CallSavedWorkflowSyncRuntime';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MISSING_WORKFLOW_ID = 'missing-workflow';

/** A call node as `parseWorkflowJson` produces it for a reloaded parent: an id, and status `loading`. */
const buildCallNode = (id: string, workflowId: string = MISSING_WORKFLOW_ID): WorkflowNode =>
  ({
    data: {
      callSavedWorkflowStatus: 'loading',
      inputs: { workflow_id: { label: '', name: 'workflow_id', value: workflowId } },
      isIntermediate: false,
      isOpen: true,
      label: '',
      nodePack: 'invokeai',
      notes: '',
      type: 'call_saved_workflow',
      useCache: true,
      version: '1.0.0',
    },
    id,
    position: { x: 0, y: 0 },
    type: 'invocation',
  }) as unknown as WorkflowNode;

const readStatuses = (graph: ProjectGraphState): (string | undefined)[] =>
  graph.nodes.map((node) => (node.type === 'invocation' ? node.data.callSavedWorkflowStatus : undefined));

const settle = async (ms: number) => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  });
};

/**
 * A child workflow that cannot be fetched has to settle: every node naming it
 * ends at `error`, so the Invoke button can say why, and the requests stop.
 *
 * Regression: the retry bookkeeping is keyed by workflow id while the status it
 * drives is per node, so two nodes naming one failing id hand the shared flag
 * back and forth, and neither the requests nor the `loading` state ever stop.
 */
describe('CallSavedWorkflowSyncRuntime with an unreachable child workflow', () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    queryClient = new QueryClient();
    getLibraryWorkflowRecordMock.mockReset();
    // The delay matters: the reconciler coalesces everything scheduled before
    // its next macrotask, so a synchronous rejection folds the `fetch` and
    // `error` cache events into a single pass. A real request separates them.
    getLibraryWorkflowRecordMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('not found')), 10);
        })
    );
  });

  afterEach(async () => {
    await act(() => root.unmount());
    queryClient.clear();
    host.remove();
  });

  const mountWith = async (nodes: WorkflowNode[]) => {
    let graph: ProjectGraphState = { ...createProjectGraph('parent'), nodes };
    const listeners = new Set<() => void>();
    const snapshot = () => ({
      galleryValues: {},
      id: 'project-1',
      isWorkflowRunning: false,
      projectGraph: graph,
      workflowValues: {},
    });
    let current = snapshot();
    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- intentionally stable for this render lifetime
    const adapter = {
      commands: {
        bindLibraryWorkflow: vi.fn(),
        editGraph: (action: ProjectGraphAction) => {
          graph = projectGraphReducer(graph, action);
          current = snapshot();
          for (const listener of listeners) {
            listener();
          }
        },
        redo: vi.fn(),
        replace: vi.fn(),
        undo: vi.fn(),
      },
      getProjectGraph: () => graph,
      notifications: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
      project: {
        getSnapshot: () => current,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      widgets: { open: vi.fn(), patchValues: vi.fn() },
    } as unknown as WorkflowUiAdapter;

    root = createRoot(host);

    await act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <WorkflowUiProvider adapter={adapter}>
            <CallSavedWorkflowSyncRuntime />
          </WorkflowUiProvider>
        </QueryClientProvider>
      );
    });

    return () => graph;
  };

  /** Every node reports the failure, and no further requests go out once they do. */
  const expectSettled = async (readGraph: () => ProjectGraphState, expected: string[]) => {
    await settle(250);

    expect(readStatuses(readGraph())).toEqual(expected);

    const settledCalls = getLibraryWorkflowRecordMock.mock.calls.length;

    await settle(250);

    expect(getLibraryWorkflowRecordMock.mock.calls.length).toBe(settledCalls);
  };

  it('settles a single node', async () => {
    const readGraph = await mountWith([buildCallNode('call-1')]);

    await expectSettled(readGraph, ['error']);
  });

  // The contrast that pins the cause: the same two nodes, but distinct ids, so
  // the shared retry flag is never contended.
  it('settles two nodes naming different unreachable workflows', async () => {
    const readGraph = await mountWith([buildCallNode('call-1', 'missing-a'), buildCallNode('call-2', 'missing-b')]);

    await expectSettled(readGraph, ['error', 'error']);
  });

  it('settles two nodes naming the same unreachable workflow', async () => {
    const readGraph = await mountWith([buildCallNode('call-1'), buildCallNode('call-2')]);

    await expectSettled(readGraph, ['error', 'error']);
  });
});
