import { describe, expect, it } from 'vitest';

import type { WorkflowEdge, WorkflowInvocationNode } from './types';

import { createProjectGraph } from './document';
import { getCanonicalWorkflowEdges, validateForLoopGraph } from './forLoops';

const node = (id: string, type: string): WorkflowInvocationNode => ({
  data: {
    inputs: {},
    isIntermediate: true,
    isOpen: true,
    label: '',
    nodePack: 'invokeai',
    notes: '',
    type,
    useCache: true,
    version: '1.0.0',
  },
  id,
  position: { x: 0, y: 0 },
  type: 'invocation',
});

const edge = (
  id: string,
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
  type: WorkflowEdge['type'] = 'default'
): WorkflowEdge => ({ id, source, sourceHandle, target, targetHandle, type });

const linkedGraph = () => {
  const forNode = node('for', 'for');
  const bodyNode = node('body', 'number');
  const returnNode = node('return', 'for_return');
  const document = {
    ...createProjectGraph('for-loop-test'),
    nodes: [forNode, bodyNode, returnNode],
    edges: [
      edge('iteration', 'for', 'item', 'body', 'value'),
      edge('body-output', 'body', 'value', 'return', 'output'),
      edge('linkage', 'for', 'loop_linkage', 'return', 'loop_linkage', 'loop_linkage'),
    ],
  };

  return { bodyNode, document, forNode, returnNode };
};

describe('For/ForReturn graph contracts', () => {
  it('accepts a direct loop linkage and excludes it from data-flow traversal', () => {
    const { document } = linkedGraph();

    expect(validateForLoopGraph(document)).toBeNull();
    expect(getCanonicalWorkflowEdges(document).find((candidate) => candidate.id === 'linkage')).toMatchObject({
      source: { field: 'loop_linkage', node_id: 'for' },
      destination: { field: 'loop_linkage', node_id: 'return' },
      type: 'loop_linkage',
    });

    expect(
      validateForLoopGraph({
        ...document,
        edges: document.edges.map((candidate) =>
          candidate.id === 'linkage' ? { ...candidate, type: 'default' as const } : candidate
        ),
      })
    ).toBe('nodes.forLoopLinkageInvalid');
  });

  it('rejects an unlinked loop and an unsupported nested loop body', () => {
    const { document } = linkedGraph();
    const unlinked = { ...document, edges: document.edges.filter((candidate) => candidate.id !== 'linkage') };
    expect(validateForLoopGraph(unlinked)).toBe('nodes.forLoopLinkageMissing');

    const innerFor = node('inner-for', 'for');
    const innerReturn = node('inner-return', 'for_return');
    const nested = {
      ...document,
      nodes: [...document.nodes, innerFor, innerReturn],
      edges: [
        ...document.edges,
        edge('nested', 'for', 'item', 'inner-for', 'collection'),
        edge('inner-iteration', 'inner-for', 'item', 'inner-return', 'output'),
        edge('inner-linkage', 'inner-for', 'loop_linkage', 'inner-return', 'loop_linkage', 'loop_linkage'),
      ],
    };
    expect(validateForLoopGraph(nested)).toBe('nodes.forLoopNestedUnsupported');
  });

  it('accepts a nested For whose final collection closes the outer body', () => {
    const document = {
      ...createProjectGraph('nested-for-loop-test'),
      nodes: [
        node('outer', 'for'),
        node('inner-collection', 'add'),
        node('inner', 'for'),
        node('inner-body', 'add'),
        node('inner-condition', 'add'),
        node('inner-return', 'for_return'),
        node('outer-return', 'for_return'),
      ],
      edges: [
        edge('outer-item', 'outer', 'item', 'inner-collection', 'value'),
        edge('inner-collection', 'inner-collection', 'value', 'inner', 'collection'),
        edge('inner-item', 'inner', 'item', 'inner-body', 'value'),
        edge('inner-item-condition', 'inner', 'item', 'inner-condition', 'value'),
        edge('inner-output', 'inner-body', 'value', 'inner-return', 'output'),
        edge('inner-condition', 'inner-condition', 'value', 'inner-return', 'continue_condition'),
        edge('inner-final', 'inner', 'output_collection', 'outer-return', 'output'),
        edge('inner-linkage', 'inner', 'loop_linkage', 'inner-return', 'loop_linkage', 'loop_linkage'),
        edge('outer-linkage', 'outer', 'loop_linkage', 'outer-return', 'loop_linkage', 'loop_linkage'),
      ],
    };

    expect(validateForLoopGraph(document)).toBeNull();
  });

  it('rejects a nested For with an external outer continuation condition', () => {
    const document = {
      ...createProjectGraph('nested-for-loop-invalid-test'),
      nodes: [
        node('outer', 'for'),
        node('inner-collection', 'add'),
        node('inner', 'for'),
        node('inner-body', 'add'),
        node('inner-return', 'for_return'),
        node('outer-return', 'for_return'),
        node('external-condition', 'add'),
      ],
      edges: [
        edge('outer-item', 'outer', 'item', 'inner-collection', 'value'),
        edge('inner-collection', 'inner-collection', 'value', 'inner', 'collection'),
        edge('inner-item', 'inner', 'item', 'inner-body', 'value'),
        edge('inner-output', 'inner-body', 'value', 'inner-return', 'output'),
        edge('inner-final', 'inner', 'output_collection', 'outer-return', 'output'),
        edge('inner-linkage', 'inner', 'loop_linkage', 'inner-return', 'loop_linkage', 'loop_linkage'),
        edge('outer-linkage', 'outer', 'loop_linkage', 'outer-return', 'loop_linkage', 'loop_linkage'),
        edge('external-condition', 'external-condition', 'value', 'outer-return', 'continue_condition'),
      ],
    };

    expect(validateForLoopGraph(document)).toBe('nodes.forLoopNestedUnsupported');
  });

  it('canonicalizes a complete connector alias without changing the stored edge list', () => {
    const forNode = node('for', 'for');
    const returnNode = node('return', 'for_return');
    const connector = {
      data: { label: '' },
      id: 'connector',
      position: { x: 0, y: 0 },
      type: 'connector' as const,
    };
    const document = {
      ...createProjectGraph('connector-loop-test'),
      nodes: [forNode, connector, returnNode],
      edges: [
        edge('for-to-connector', 'for', 'loop_linkage', 'connector', 'in'),
        edge('connector-to-return', 'connector', 'out', 'return', 'loop_linkage'),
      ],
    };

    expect(validateForLoopGraph(document)).toBe('nodes.forLoopMissingIterationOutput');
    expect(getCanonicalWorkflowEdges(document)).toEqual([
      {
        id: 'resolved-loop-linkage-for-return',
        source: { field: 'loop_linkage', node_id: 'for' },
        destination: { field: 'loop_linkage', node_id: 'return' },
        type: 'loop_linkage',
      },
    ]);
  });
});
