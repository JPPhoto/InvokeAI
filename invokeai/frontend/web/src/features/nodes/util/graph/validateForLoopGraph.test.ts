import type { Graph } from 'services/api/types';
import { describe, expect, it } from 'vitest';

import { validateForLoopGraph } from './validateForLoopGraph';

type TestNode = { id: string; type: string; body_id?: string | null };
type TestEdge = {
  source: { node_id: string; field: string };
  destination: { node_id: string; field: string };
};

const buildGraph = (nodes: TestNode[], edges: TestEdge[]): Graph =>
  ({
    id: 'graph',
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    edges,
  }) as unknown as Graph;

const edge = (source: string, sourceField: string, destination: string, destinationField: string): TestEdge => ({
  source: { node_id: source, field: sourceField },
  destination: { node_id: destination, field: destinationField },
});

describe(validateForLoopGraph.name, () => {
  it('accepts a valid For body', () => {
    const graph = buildGraph(
      [
        { id: 'for', type: 'for' },
        { id: 'body', type: 'add' },
        { id: 'return', type: 'for_return' },
        { id: 'after', type: 'collect' },
      ],
      [
        edge('for', 'item', 'body', 'a'),
        edge('body', 'value', 'return', 'output'),
        edge('for', 'output_collection', 'after', 'item'),
      ]
    );

    expect(validateForLoopGraph(graph)).toBeNull();
  });

  it('accepts a valid For body with durable identity', () => {
    const graph = buildGraph(
      [
        { id: 'for', type: 'for', body_id: 'body-1' },
        { id: 'body', type: 'add' },
        { id: 'return', type: 'for_return', body_id: 'body-1' },
      ],
      [edge('for', 'item', 'body', 'a'), edge('body', 'value', 'return', 'output')]
    );

    expect(validateForLoopGraph(graph)).toBeNull();
  });

  it.each([
    {
      name: 'missing ForReturn identity',
      nodes: [
        { id: 'for', type: 'for', body_id: 'body-1' },
        { id: 'return', type: 'for_return' },
      ],
      edges: [edge('for', 'item', 'return', 'output')],
      expected: 'nodes.forLoopBodyIdentityMissing',
    },
    {
      name: 'missing For identity',
      nodes: [
        { id: 'for', type: 'for' },
        { id: 'return', type: 'for_return', body_id: 'body-1' },
      ],
      edges: [edge('for', 'item', 'return', 'output')],
      expected: 'nodes.forLoopBodyIdentityMissing',
    },
    {
      name: 'stale ForReturn identity',
      nodes: [{ id: 'return', type: 'for_return', body_id: 'missing-for' }],
      edges: [],
      expected: 'nodes.forLoopBodyIdentityStale',
    },
    {
      name: 'duplicate For identities',
      nodes: [
        { id: 'first', type: 'for', body_id: 'body-1' },
        { id: 'second', type: 'for', body_id: 'body-1' },
      ],
      edges: [],
      expected: 'nodes.forLoopBodyIdentityDuplicate',
    },
    {
      name: 'duplicate ForReturn identities',
      nodes: [
        { id: 'first', type: 'for_return', body_id: 'body-1' },
        { id: 'second', type: 'for_return', body_id: 'body-1' },
      ],
      edges: [],
      expected: 'nodes.forLoopBodyIdentityDuplicate',
    },
    {
      name: 'mismatched identities',
      nodes: [
        { id: 'for', type: 'for', body_id: 'body-1' },
        { id: 'return', type: 'for_return', body_id: 'body-2' },
      ],
      edges: [edge('for', 'item', 'return', 'output')],
      expected: 'nodes.forLoopBodyIdentityMismatch',
    },
  ])('rejects $name', ({ nodes, edges, expected }) => {
    expect(validateForLoopGraph(buildGraph(nodes, edges))).toBe(expected);
  });

  it.each([
    {
      name: 'missing iteration output',
      nodes: [
        { id: 'for', type: 'for' },
        { id: 'return', type: 'for_return' },
      ],
      edges: [],
      expected: 'nodes.forLoopMissingIterationOutput',
    },
    {
      name: 'missing ForReturn',
      nodes: [
        { id: 'for', type: 'for' },
        { id: 'body', type: 'add' },
      ],
      edges: [edge('for', 'item', 'body', 'a')],
      expected: 'nodes.forLoopReturnCount',
    },
    {
      name: 'multiple ForReturn nodes',
      nodes: [
        { id: 'for', type: 'for' },
        { id: 'first', type: 'for_return' },
        { id: 'second', type: 'for_return' },
      ],
      edges: [edge('for', 'item', 'first', 'output'), edge('for', 'state', 'second', 'state')],
      expected: 'nodes.forLoopReturnCount',
    },
    {
      name: 'unterminated body branch',
      nodes: [
        { id: 'for', type: 'for' },
        { id: 'body', type: 'add' },
        { id: 'return', type: 'for_return' },
        { id: 'escape', type: 'add' },
      ],
      edges: [
        edge('for', 'item', 'body', 'a'),
        edge('body', 'value', 'return', 'output'),
        edge('for', 'state', 'escape', 'a'),
      ],
      expected: 'nodes.forLoopUnterminatedBody',
    },
    {
      name: 'nested For',
      nodes: [
        { id: 'for', type: 'for' },
        { id: 'nested', type: 'for' },
        { id: 'return', type: 'for_return' },
      ],
      edges: [edge('for', 'item', 'nested', 'collection'), edge('nested', 'item', 'return', 'output')],
      expected: 'nodes.forLoopNestedUnsupported',
    },
    {
      name: 'body Iterate',
      nodes: [
        { id: 'for', type: 'for' },
        { id: 'iterate', type: 'iterate' },
        { id: 'return', type: 'for_return' },
      ],
      edges: [edge('for', 'item', 'iterate', 'collection'), edge('iterate', 'item', 'return', 'output')],
      expected: 'nodes.forLoopIterateUnsupported',
    },
    {
      name: 'iterator-derived external body input',
      nodes: [
        { id: 'collection', type: 'integer_collection' },
        { id: 'iterate', type: 'iterate' },
        { id: 'external', type: 'add' },
        { id: 'for', type: 'for' },
        { id: 'body', type: 'add' },
        { id: 'return', type: 'for_return' },
      ],
      edges: [
        edge('collection', 'collection', 'iterate', 'collection'),
        edge('iterate', 'item', 'external', 'a'),
        edge('for', 'item', 'body', 'a'),
        edge('external', 'value', 'body', 'b'),
        edge('body', 'value', 'return', 'output'),
      ],
      expected: 'nodes.forLoopIteratorInputUnsupported',
    },
    {
      name: 'final output feeding body',
      nodes: [
        { id: 'for', type: 'for' },
        { id: 'return', type: 'for_return' },
      ],
      edges: [edge('for', 'item', 'return', 'output'), edge('for', 'final_state', 'return', 'state')],
      expected: 'nodes.forLoopFinalOutputInBody',
    },
    {
      name: 'body output escaping before ForReturn',
      nodes: [
        { id: 'for', type: 'for' },
        { id: 'body', type: 'add' },
        { id: 'return', type: 'for_return' },
        { id: 'escape', type: 'add' },
      ],
      edges: [
        edge('for', 'item', 'body', 'a'),
        edge('body', 'value', 'return', 'output'),
        edge('body', 'value', 'escape', 'a'),
      ],
      expected: 'nodes.forLoopUnterminatedBody',
    },
    {
      name: 'ForReturn shared by two loops',
      nodes: [
        { id: 'first', type: 'for' },
        { id: 'second', type: 'for' },
        { id: 'return', type: 'for_return' },
      ],
      edges: [edge('first', 'item', 'return', 'output'), edge('second', 'item', 'return', 'output')],
      expected: 'nodes.forReturnOwnership',
    },
  ])('rejects $name', ({ nodes, edges, expected }) => {
    expect(validateForLoopGraph(buildGraph(nodes, edges))).toBe(expected);
  });
});
