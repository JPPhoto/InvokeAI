import type { Graph } from 'services/api/types';
import { describe, expect, it } from 'vitest';

import { validateForLoopGraph } from './validateForLoopGraph';

type TestNode = { id: string; type: string };
type TestEdge = {
  type?: 'default' | 'loop_linkage';
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
  type: 'default',
  source: { node_id: source, field: sourceField },
  destination: { node_id: destination, field: destinationField },
});

const linkage = (source: string, destination: string): TestEdge => ({
  type: 'loop_linkage',
  source: { node_id: source, field: 'loop_linkage' },
  destination: { node_id: destination, field: 'loop_linkage' },
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
        linkage('for', 'return'),
      ]
    );

    expect(validateForLoopGraph(graph)).toBeNull();
  });

  it('requires an explicit loop linkage', () => {
    const graph = buildGraph(
      [
        { id: 'for', type: 'for' },
        { id: 'body', type: 'add' },
        { id: 'return', type: 'for_return' },
      ],
      [edge('for', 'item', 'body', 'a'), edge('body', 'value', 'return', 'output')]
    );

    expect(validateForLoopGraph(graph)).toBe('nodes.forLoopLinkageMissing');
  });

  it('rejects a linkage with the wrong endpoint fields', () => {
    const graph = buildGraph(
      [
        { id: 'source', type: 'add' },
        { id: 'for', type: 'for' },
        { id: 'body', type: 'add' },
        { id: 'return', type: 'for_return' },
      ],
      [
        edge('for', 'item', 'body', 'a'),
        edge('body', 'value', 'return', 'output'),
        {
          type: 'loop_linkage',
          source: { node_id: 'for', field: 'item' },
          destination: { node_id: 'return', field: 'loop_linkage' },
        },
      ]
    );

    expect(validateForLoopGraph(graph)).toBe('nodes.forLoopLinkageInvalid');
  });

  it('rejects an internal Iterate predicate branch without scalar aggregation', () => {
    const graph = buildGraph(
      [
        { id: 'for', type: 'for' },
        { id: 'iterate', type: 'iterate' },
        { id: 'body', type: 'add' },
        { id: 'condition', type: 'add' },
        { id: 'collect', type: 'collect' },
        { id: 'return', type: 'for_return' },
      ],
      [
        edge('for', 'item', 'iterate', 'collection'),
        edge('iterate', 'item', 'body', 'a'),
        edge('iterate', 'item', 'condition', 'value'),
        edge('body', 'value', 'collect', 'item'),
        edge('collect', 'collection', 'return', 'output'),
        edge('condition', 'value', 'return', 'continue_condition'),
        linkage('for', 'return'),
      ]
    );

    expect(validateForLoopGraph(graph)).toBe('nodes.forLoopIterateUnsupported');
  });

  it('accepts one nested For whose final collection closes the outer body', () => {
    const graph = buildGraph(
      [
        { id: 'outer', type: 'for' },
        { id: 'inner-collection', type: 'add' },
        { id: 'inner', type: 'for' },
        { id: 'inner-body', type: 'add' },
        { id: 'inner-condition', type: 'add' },
        { id: 'inner-return', type: 'for_return' },
        { id: 'outer-return', type: 'for_return' },
      ],
      [
        edge('outer', 'item', 'inner-collection', 'value'),
        edge('inner-collection', 'value', 'inner', 'collection'),
        edge('inner', 'item', 'inner-body', 'value'),
        edge('inner', 'item', 'inner-condition', 'value'),
        edge('inner-body', 'value', 'inner-return', 'output'),
        edge('inner-condition', 'value', 'inner-return', 'continue_condition'),
        edge('inner', 'output_collection', 'outer-return', 'output'),
        linkage('inner', 'inner-return'),
        linkage('outer', 'outer-return'),
      ]
    );

    expect(validateForLoopGraph(graph)).toBeNull();
  });

  it('accepts nested ForReturn state produced by the inner body', () => {
    const graph = buildGraph(
      [
        { id: 'outer', type: 'for' },
        { id: 'inner-collection', type: 'add' },
        { id: 'inner', type: 'for' },
        { id: 'inner-body', type: 'add' },
        { id: 'inner-state', type: 'add' },
        { id: 'inner-return', type: 'for_return' },
        { id: 'outer-return', type: 'for_return' },
      ],
      [
        edge('outer', 'item', 'inner-collection', 'value'),
        edge('inner-collection', 'value', 'inner', 'collection'),
        edge('inner', 'item', 'inner-body', 'value'),
        edge('inner', 'state', 'inner-state', 'state'),
        edge('inner', 'item', 'inner-state', 'value'),
        edge('inner-body', 'value', 'inner-return', 'output'),
        edge('inner-state', 'state', 'inner-return', 'state'),
        edge('inner', 'output_collection', 'outer-return', 'output'),
        linkage('inner', 'inner-return'),
        linkage('outer', 'outer-return'),
      ]
    );

    expect(validateForLoopGraph(graph)).toBeNull();
  });

  it('rejects an outer nested ForReturn condition from an external scope', () => {
    const graph = buildGraph(
      [
        { id: 'outer', type: 'for' },
        { id: 'inner-collection', type: 'add' },
        { id: 'inner', type: 'for' },
        { id: 'inner-body', type: 'add' },
        { id: 'inner-return', type: 'for_return' },
        { id: 'outer-return', type: 'for_return' },
        { id: 'external-condition', type: 'add' },
      ],
      [
        edge('outer', 'item', 'inner-collection', 'value'),
        edge('inner-collection', 'value', 'inner', 'collection'),
        edge('inner', 'item', 'inner-body', 'value'),
        edge('inner-body', 'value', 'inner-return', 'output'),
        edge('inner', 'output_collection', 'outer-return', 'output'),
        linkage('inner', 'inner-return'),
        linkage('outer', 'outer-return'),
        edge('external-condition', 'value', 'outer-return', 'continue_condition'),
      ]
    );

    expect(validateForLoopGraph(graph)).toBe('nodes.forLoopNestedUnsupported');
  });

  it('accepts deeper nested For boundaries when each boundary has one child', () => {
    const graph = buildGraph(
      [
        { id: 'outer', type: 'for' },
        { id: 'outer-collection', type: 'add' },
        { id: 'inner', type: 'for' },
        { id: 'inner-collection', type: 'add' },
        { id: 'leaf', type: 'for' },
        { id: 'leaf-body', type: 'add' },
        { id: 'leaf-return', type: 'for_return' },
        { id: 'inner-return', type: 'for_return' },
        { id: 'outer-return', type: 'for_return' },
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
        linkage('leaf', 'leaf-return'),
        linkage('inner', 'inner-return'),
        linkage('outer', 'outer-return'),
      ]
    );

    expect(validateForLoopGraph(graph)).toBeNull();
  });

  it('accepts a nested For with an outer continuation after the inner final output', () => {
    const graph = buildGraph(
      [
        { id: 'outer', type: 'for' },
        { id: 'inner-collection', type: 'add' },
        { id: 'inner', type: 'for' },
        { id: 'inner-body', type: 'add' },
        { id: 'inner-return', type: 'for_return' },
        { id: 'continuation', type: 'add' },
        { id: 'continuation-tail', type: 'add' },
        { id: 'outer-return', type: 'for_return' },
      ],
      [
        edge('outer', 'item', 'inner-collection', 'value'),
        edge('inner-collection', 'value', 'inner', 'collection'),
        edge('inner', 'item', 'inner-body', 'value'),
        edge('inner-body', 'value', 'inner-return', 'output'),
        edge('inner', 'output_collection', 'continuation', 'value'),
        edge('continuation', 'value', 'continuation-tail', 'value'),
        edge('continuation-tail', 'value', 'outer-return', 'output'),
        edge('continuation-tail', 'value', 'outer-return', 'continue_condition'),
        linkage('inner', 'inner-return'),
        linkage('outer', 'outer-return'),
      ]
    );

    expect(validateForLoopGraph(graph)).toBeNull();
  });

  it('rejects a nested continuation branch that does not reach the outer ForReturn', () => {
    const graph = buildGraph(
      [
        { id: 'outer', type: 'for' },
        { id: 'inner-collection', type: 'add' },
        { id: 'inner', type: 'for' },
        { id: 'inner-body', type: 'add' },
        { id: 'inner-return', type: 'for_return' },
        { id: 'continuation', type: 'add' },
        { id: 'dead-branch', type: 'add' },
        { id: 'outer-return', type: 'for_return' },
      ],
      [
        edge('outer', 'item', 'inner-collection', 'value'),
        edge('inner-collection', 'value', 'inner', 'collection'),
        edge('inner', 'item', 'inner-body', 'value'),
        edge('inner-body', 'value', 'inner-return', 'output'),
        edge('inner', 'output_collection', 'continuation', 'value'),
        edge('continuation', 'value', 'outer-return', 'output'),
        edge('continuation', 'value', 'dead-branch', 'value'),
        linkage('inner', 'inner-return'),
        linkage('outer', 'outer-return'),
      ]
    );

    expect(validateForLoopGraph(graph)).toBe('nodes.forLoopNestedUnsupported');
  });

  it('accepts independent nested For children with an explicit fan-in continuation', () => {
    const graph = buildGraph(
      [
        { id: 'outer', type: 'for' },
        { id: 'first', type: 'for' },
        { id: 'second', type: 'for' },
        { id: 'first-body', type: 'add' },
        { id: 'second-body', type: 'add' },
        { id: 'first-return', type: 'for_return' },
        { id: 'second-return', type: 'for_return' },
        { id: 'fan-in', type: 'add' },
        { id: 'outer-return', type: 'for_return' },
      ],
      [
        edge('outer', 'item', 'first', 'collection'),
        edge('outer', 'item', 'second', 'collection'),
        edge('first', 'item', 'first-body', 'value'),
        edge('first-body', 'value', 'first-return', 'output'),
        edge('second', 'item', 'second-body', 'value'),
        edge('second-body', 'value', 'second-return', 'output'),
        edge('first', 'output_collection', 'fan-in', 'first'),
        edge('second', 'output_collection', 'fan-in', 'second'),
        edge('fan-in', 'value', 'outer-return', 'output'),
        linkage('first', 'first-return'),
        linkage('second', 'second-return'),
        linkage('outer', 'outer-return'),
      ]
    );

    expect(validateForLoopGraph(graph)).toBeNull();
  });

  it.each([
    {
      name: 'missing loop linkage',
      nodes: [
        { id: 'for', type: 'for' },
        { id: 'return', type: 'for_return' },
      ],
      edges: [edge('for', 'item', 'return', 'output')],
      expected: 'nodes.forLoopLinkageMissing',
    },
    {
      name: 'duplicate loop linkage',
      nodes: [
        { id: 'for', type: 'for' },
        { id: 'return', type: 'for_return' },
      ],
      edges: [edge('for', 'item', 'return', 'output'), linkage('for', 'return'), linkage('for', 'return')],
      expected: 'nodes.forLoopLinkageDuplicate',
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
        linkage('for', 'return'),
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
        linkage('for', 'return'),
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
        linkage('for', 'return'),
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
        linkage('for', 'return'),
      ],
      expected: 'nodes.forReturnInputCount',
    },
    {
      name: 'duplicate ForReturn continue conditions',
      nodes: [
        { id: 'for', type: 'for' },
        { id: 'first', type: 'add' },
        { id: 'second', type: 'add' },
        { id: 'return', type: 'for_return' },
      ],
      edges: [
        edge('for', 'item', 'return', 'output'),
        edge('first', 'value', 'return', 'continue_condition'),
        edge('second', 'value', 'return', 'continue_condition'),
        linkage('for', 'return'),
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
      edges: [linkage('for', 'return')],
      expected: 'nodes.forLoopMissingIterationOutput',
    },
    {
      name: 'missing ForReturn',
      nodes: [
        { id: 'for', type: 'for' },
        { id: 'body', type: 'add' },
      ],
      edges: [edge('for', 'item', 'body', 'a')],
      expected: 'nodes.forLoopLinkageMissing',
    },
    {
      name: 'multiple ForReturn nodes',
      nodes: [
        { id: 'for', type: 'for' },
        { id: 'first', type: 'for_return' },
        { id: 'second', type: 'for_return' },
      ],
      edges: [edge('for', 'item', 'first', 'output'), edge('for', 'state', 'second', 'state'), linkage('for', 'first')],
      expected: 'nodes.forLoopLinkageMissing',
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
        linkage('for', 'return'),
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
      edges: [
        edge('for', 'item', 'nested', 'collection'),
        edge('nested', 'item', 'return', 'output'),
        linkage('nested', 'return'),
      ],
      expected: 'nodes.forLoopLinkageMissing',
    },
    {
      name: 'multiple direct nested For children',
      nodes: [
        { id: 'outer', type: 'for' },
        { id: 'first', type: 'for' },
        { id: 'second', type: 'for' },
        { id: 'first-return', type: 'for_return' },
        { id: 'second-return', type: 'for_return' },
        { id: 'outer-return', type: 'for_return' },
      ],
      edges: [
        edge('outer', 'item', 'first', 'collection'),
        edge('outer', 'item', 'second', 'collection'),
        edge('first', 'item', 'first-return', 'output'),
        edge('second', 'item', 'second-return', 'output'),
        edge('first', 'output_collection', 'outer-return', 'output'),
        linkage('first', 'first-return'),
        linkage('second', 'second-return'),
        linkage('outer', 'outer-return'),
      ],
      expected: 'nodes.forLoopNestedUnsupported',
    },
    {
      name: 'mixed nested For and Iterate body',
      nodes: [
        { id: 'outer', type: 'for' },
        { id: 'inner-collection', type: 'add' },
        { id: 'inner', type: 'for' },
        { id: 'iterate-collection', type: 'add' },
        { id: 'iterate', type: 'iterate' },
        { id: 'body', type: 'add' },
        { id: 'collect', type: 'collect' },
        { id: 'inner-return', type: 'for_return' },
        { id: 'outer-return', type: 'for_return' },
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
        linkage('inner', 'inner-return'),
        linkage('outer', 'outer-return'),
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
      edges: [
        edge('for', 'item', 'iterate', 'collection'),
        edge('iterate', 'item', 'return', 'output'),
        linkage('for', 'return'),
      ],
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
        linkage('for', 'return'),
      ],
      expected: 'nodes.forLoopIteratorInputUnsupported',
    },
    {
      name: 'final output feeding body',
      nodes: [
        { id: 'for', type: 'for' },
        { id: 'return', type: 'for_return' },
      ],
      edges: [
        edge('for', 'item', 'return', 'output'),
        edge('for', 'final_state', 'return', 'state'),
        linkage('for', 'return'),
      ],
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
        linkage('for', 'return'),
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
      edges: [
        edge('first', 'item', 'return', 'output'),
        edge('second', 'item', 'return', 'output'),
        linkage('first', 'return'),
        linkage('second', 'return'),
      ],
      expected: 'nodes.forLoopLinkageDuplicate',
    },
  ])('rejects $name', ({ nodes, edges, expected }) => {
    expect(validateForLoopGraph(buildGraph(nodes, edges))).toBe(expected);
  });
});
