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

  it('rejects graph edges into a durable body identity', () => {
    const graph = buildGraph(
      [
        { id: 'source', type: 'add' },
        { id: 'for', type: 'for', body_id: 'body-1' },
        { id: 'body', type: 'add' },
        { id: 'return', type: 'for_return', body_id: 'body-1' },
      ],
      [
        edge('source', 'value', 'for', 'body_id'),
        edge('for', 'item', 'body', 'a'),
        edge('body', 'value', 'return', 'output'),
      ]
    );

    expect(validateForLoopGraph(graph)).toBe('nodes.forLoopBodyIdentityEdge');
  });

  it('accepts an internal Iterate collapsed by Collect', () => {
    const graph = buildGraph(
      [
        { id: 'for', type: 'for' },
        { id: 'iterate', type: 'iterate' },
        { id: 'body', type: 'add' },
        { id: 'collect', type: 'collect' },
        { id: 'return', type: 'for_return' },
      ],
      [
        edge('for', 'item', 'iterate', 'collection'),
        edge('iterate', 'item', 'body', 'a'),
        edge('body', 'value', 'collect', 'item'),
        edge('collect', 'collection', 'return', 'output'),
      ]
    );

    expect(validateForLoopGraph(graph)).toBeNull();
  });

  it('accepts one identity-bearing nested For whose final collection closes the outer body', () => {
    const graph = buildGraph(
      [
        { id: 'outer', type: 'for', body_id: 'outer-body' },
        { id: 'inner-collection', type: 'add' },
        { id: 'inner', type: 'for', body_id: 'inner-body' },
        { id: 'inner-body', type: 'add' },
        { id: 'inner-return', type: 'for_return', body_id: 'inner-body' },
        { id: 'outer-return', type: 'for_return', body_id: 'outer-body' },
      ],
      [
        edge('outer', 'item', 'inner-collection', 'value'),
        edge('inner-collection', 'value', 'inner', 'collection'),
        edge('inner', 'item', 'inner-body', 'value'),
        edge('inner-body', 'value', 'inner-return', 'output'),
        edge('inner', 'output_collection', 'outer-return', 'output'),
      ]
    );

    expect(validateForLoopGraph(graph)).toBeNull();
  });

  it('accepts deeper nested For boundaries when each boundary has one child', () => {
    const graph = buildGraph(
      [
        { id: 'outer', type: 'for', body_id: 'outer-body' },
        { id: 'outer-collection', type: 'add' },
        { id: 'inner', type: 'for', body_id: 'inner-body' },
        { id: 'inner-collection', type: 'add' },
        { id: 'leaf', type: 'for', body_id: 'leaf-body' },
        { id: 'leaf-body', type: 'add' },
        { id: 'leaf-return', type: 'for_return', body_id: 'leaf-body' },
        { id: 'inner-return', type: 'for_return', body_id: 'inner-body' },
        { id: 'outer-return', type: 'for_return', body_id: 'outer-body' },
      ],
      [
        edge('outer', 'item', 'outer-collection', 'value'),
        edge('outer-collection', 'value', 'inner', 'collection'),
        edge('inner', 'item', 'inner-collection', 'value'),
        edge('inner-collection', 'value', 'leaf', 'collection'),
        edge('leaf', 'item', 'leaf-body', 'value'),
        edge('leaf-body', 'value', 'leaf-return', 'output'),
        edge('leaf', 'output_collection', 'inner-return', 'output'),
        edge('inner', 'output_collection', 'outer-return', 'output'),
      ]
    );

    expect(validateForLoopGraph(graph)).toBeNull();
  });

  it('accepts a nested For with an outer continuation after the inner final output', () => {
    const graph = buildGraph(
      [
        { id: 'outer', type: 'for', body_id: 'outer-body' },
        { id: 'inner-collection', type: 'add' },
        { id: 'inner', type: 'for', body_id: 'inner-body' },
        { id: 'inner-body', type: 'add' },
        { id: 'inner-return', type: 'for_return', body_id: 'inner-body' },
        { id: 'continuation', type: 'add' },
        { id: 'continuation-tail', type: 'add' },
        { id: 'outer-return', type: 'for_return', body_id: 'outer-body' },
      ],
      [
        edge('outer', 'item', 'inner-collection', 'value'),
        edge('inner-collection', 'value', 'inner', 'collection'),
        edge('inner', 'item', 'inner-body', 'value'),
        edge('inner-body', 'value', 'inner-return', 'output'),
        edge('inner', 'output_collection', 'continuation', 'value'),
        edge('continuation', 'value', 'continuation-tail', 'value'),
        edge('continuation-tail', 'value', 'outer-return', 'output'),
      ]
    );

    expect(validateForLoopGraph(graph)).toBeNull();
  });

  it('rejects a nested continuation branch that does not reach the outer ForReturn', () => {
    const graph = buildGraph(
      [
        { id: 'outer', type: 'for', body_id: 'outer-body' },
        { id: 'inner-collection', type: 'add' },
        { id: 'inner', type: 'for', body_id: 'inner-body' },
        { id: 'inner-body', type: 'add' },
        { id: 'inner-return', type: 'for_return', body_id: 'inner-body' },
        { id: 'continuation', type: 'add' },
        { id: 'dead-branch', type: 'add' },
        { id: 'outer-return', type: 'for_return', body_id: 'outer-body' },
      ],
      [
        edge('outer', 'item', 'inner-collection', 'value'),
        edge('inner-collection', 'value', 'inner', 'collection'),
        edge('inner', 'item', 'inner-body', 'value'),
        edge('inner-body', 'value', 'inner-return', 'output'),
        edge('inner', 'output_collection', 'continuation', 'value'),
        edge('continuation', 'value', 'outer-return', 'output'),
        edge('continuation', 'value', 'dead-branch', 'value'),
      ]
    );

    expect(validateForLoopGraph(graph)).toBe('nodes.forLoopNestedUnsupported');
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
    {
      name: 'empty For identity',
      nodes: [{ id: 'for', type: 'for', body_id: '' }],
      edges: [],
      expected: 'nodes.forLoopBodyIdentityEmpty',
    },
    {
      name: 'empty ForReturn identity',
      nodes: [{ id: 'return', type: 'for_return', body_id: '' }],
      edges: [],
      expected: 'nodes.forLoopBodyIdentityEmpty',
    },
    {
      name: 'duplicate For collection inputs',
      nodes: [
        { id: 'for', type: 'for' },
        { id: 'first', type: 'add' },
        { id: 'second', type: 'add' },
        { id: 'return', type: 'for_return' },
      ],
      edges: [
        edge('first', 'value', 'for', 'collection'),
        edge('second', 'value', 'for', 'collection'),
        edge('for', 'item', 'return', 'output'),
      ],
      expected: 'nodes.forLoopInputCount',
    },
    {
      name: 'duplicate For state inputs',
      nodes: [
        { id: 'for', type: 'for' },
        { id: 'first', type: 'add' },
        { id: 'second', type: 'add' },
        { id: 'return', type: 'for_return' },
      ],
      edges: [
        edge('first', 'value', 'for', 'state'),
        edge('second', 'value', 'for', 'state'),
        edge('for', 'item', 'return', 'output'),
      ],
      expected: 'nodes.forLoopInputCount',
    },
    {
      name: 'duplicate ForReturn outputs',
      nodes: [
        { id: 'for', type: 'for' },
        { id: 'first', type: 'add' },
        { id: 'second', type: 'add' },
        { id: 'return', type: 'for_return' },
      ],
      edges: [
        edge('for', 'item', 'return', 'output'),
        edge('first', 'value', 'return', 'output'),
        edge('second', 'value', 'return', 'output'),
      ],
      expected: 'nodes.forReturnInputCount',
    },
    {
      name: 'duplicate ForReturn state inputs',
      nodes: [
        { id: 'for', type: 'for' },
        { id: 'first', type: 'add' },
        { id: 'second', type: 'add' },
        { id: 'return', type: 'for_return' },
      ],
      edges: [
        edge('for', 'item', 'return', 'output'),
        edge('first', 'value', 'return', 'state'),
        edge('second', 'value', 'return', 'state'),
      ],
      expected: 'nodes.forReturnInputCount',
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
      name: 'multiple direct nested For children',
      nodes: [
        { id: 'outer', type: 'for', body_id: 'outer-body' },
        { id: 'first', type: 'for', body_id: 'first-body' },
        { id: 'second', type: 'for', body_id: 'second-body' },
        { id: 'first-return', type: 'for_return', body_id: 'first-body' },
        { id: 'second-return', type: 'for_return', body_id: 'second-body' },
        { id: 'outer-return', type: 'for_return', body_id: 'outer-body' },
      ],
      edges: [
        edge('outer', 'item', 'first', 'collection'),
        edge('outer', 'item', 'second', 'collection'),
        edge('first', 'item', 'first-return', 'output'),
        edge('second', 'item', 'second-return', 'output'),
        edge('first', 'output_collection', 'outer-return', 'output'),
      ],
      expected: 'nodes.forLoopNestedUnsupported',
    },
    {
      name: 'mixed nested For and Iterate body',
      nodes: [
        { id: 'outer', type: 'for', body_id: 'outer-body' },
        { id: 'inner-collection', type: 'add' },
        { id: 'inner', type: 'for', body_id: 'inner-body' },
        { id: 'iterate-collection', type: 'add' },
        { id: 'iterate', type: 'iterate' },
        { id: 'body', type: 'add' },
        { id: 'collect', type: 'collect' },
        { id: 'inner-return', type: 'for_return', body_id: 'inner-body' },
        { id: 'outer-return', type: 'for_return', body_id: 'outer-body' },
      ],
      edges: [
        edge('outer', 'item', 'inner-collection', 'value'),
        edge('inner-collection', 'value', 'inner', 'collection'),
        edge('inner', 'item', 'iterate-collection', 'value'),
        edge('iterate-collection', 'value', 'iterate', 'collection'),
        edge('iterate', 'item', 'body', 'value'),
        edge('body', 'value', 'collect', 'item'),
        edge('collect', 'collection', 'inner-return', 'output'),
        edge('inner', 'output_collection', 'outer-return', 'output'),
      ],
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
