import { getInitialWorkflow } from 'features/nodes/store/nodesSlice';
import { buildEdge, buildNode, call_saved_workflow, for_loop, for_return } from 'features/nodes/store/util/testUtils';
import { describe, expect, it } from 'vitest';

describe('buildWorkflowFast', () => {
  it('serializes loop linkage handles as loop_linkage edges even when the edge type is stale', async () => {
    Object.assign(globalThis, {
      window: {
        location: {
          origin: 'http://localhost',
        },
      },
    });

    const { buildWorkflowFast } = await import('features/nodes/util/workflow/buildWorkflow');
    const forNode = buildNode(for_loop);
    const returnNode = buildNode(for_return);

    const workflow = buildWorkflowFast({
      _version: 1,
      formFieldInitialValues: {},
      ...getInitialWorkflow(),
      nodes: [forNode, returnNode],
      edges: [buildEdge(forNode.id, 'loop_linkage', returnNode.id, 'loop_linkage')],
    });

    expect(workflow.edges).toEqual([
      expect.objectContaining({
        type: 'loop_linkage',
        source: forNode.id,
        sourceHandle: 'loop_linkage',
        target: returnNode.id,
        targetHandle: 'loop_linkage',
      }),
    ]);
  });

  it('persists the selected workflow id for call_saved_workflow nodes', async () => {
    Object.assign(globalThis, {
      window: {
        location: {
          origin: 'http://localhost',
        },
      },
    });

    const { buildWorkflowFast } = await import('features/nodes/util/workflow/buildWorkflow');
    const node = buildNode(call_saved_workflow);
    const workflowIdInput = node.data.inputs.workflow_id;
    if (!workflowIdInput) {
      throw new Error('Expected workflow_id input');
    }
    workflowIdInput.value = 'workflow-123';

    const workflow = buildWorkflowFast({
      _version: 1,
      formFieldInitialValues: {},
      ...getInitialWorkflow(),
      nodes: [node],
      edges: [],
    });

    expect(workflow.nodes).toHaveLength(1);
    expect(workflow.nodes[0]?.type).toBe('invocation');
    if (workflow.nodes[0]?.type !== 'invocation') {
      throw new Error('Expected invocation node');
    }
    expect(workflow.nodes[0].data.type).toBe('call_saved_workflow');
    const serializedWorkflowIdInput = workflow.nodes[0].data.inputs.workflow_id;
    if (!serializedWorkflowIdInput) {
      throw new Error('Expected serialized workflow_id input');
    }
    expect(serializedWorkflowIdInput.value).toBe('workflow-123');
  });
});
