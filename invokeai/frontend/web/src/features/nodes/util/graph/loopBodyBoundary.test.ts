import {
  add,
  buildEdge,
  buildLoopLinkageEdge,
  buildNode,
  for_loop,
  for_return,
} from 'features/nodes/store/util/testUtils';
import type { AnyEdge, AnyNode } from 'features/nodes/types/invocation';
import { describe, expect, it } from 'vitest';

import { getForLoopBodyBoundaries } from './loopBodyBoundary';

const setNodeId = (node: AnyNode, id: string): AnyNode => {
  node.id = id;
  node.data.id = id;
  return node;
};

const edge = (source: string, sourceHandle: string, target: string, targetHandle: string): AnyEdge =>
  buildEdge(source, sourceHandle, target, targetHandle);

describe(getForLoopBodyBoundaries.name, () => {
  it('resolves a body using its explicit loop linkage', () => {
    const forNode = setNodeId(buildNode(for_loop), 'for');
    const bodyNode = setNodeId(buildNode(add), 'body');
    const returnNode = setNodeId(buildNode(for_return), 'return');

    const boundaries = getForLoopBodyBoundaries(
      [forNode, bodyNode, returnNode],
      [
        edge('for', 'item', 'body', 'a'),
        edge('body', 'value', 'return', 'output'),
        buildLoopLinkageEdge('for', 'return'),
      ]
    );

    expect(boundaries).toEqual([
      expect.objectContaining({
        forNodeId: 'for',
        returnNodeId: 'return',
        bodyNodeIds: ['for', 'body', 'return'],
        status: 'complete',
      }),
    ]);
  });

  it('reports missing loop linkage even when the data path is complete', () => {
    const forNode = setNodeId(buildNode(for_loop), 'for');
    const bodyNode = setNodeId(buildNode(add), 'body');
    const returnNode = setNodeId(buildNode(for_return), 'return');

    const boundaries = getForLoopBodyBoundaries(
      [forNode, bodyNode, returnNode],
      [edge('for', 'item', 'body', 'a'), edge('body', 'value', 'return', 'output')]
    );

    expect(boundaries[0]).toEqual(
      expect.objectContaining({ forNodeId: 'for', returnNodeId: 'return', status: 'missing_linkage' })
    );
  });

  it('reports a linkage whose return is detached from the body', () => {
    const forNode = setNodeId(buildNode(for_loop), 'for');
    const bodyNode = setNodeId(buildNode(add), 'body');
    const returnNode = setNodeId(buildNode(for_return), 'return');

    const boundaries = getForLoopBodyBoundaries(
      [forNode, bodyNode, returnNode],
      [edge('for', 'item', 'body', 'a'), buildLoopLinkageEdge('for', 'return')]
    );

    expect(boundaries[0]).toEqual(
      expect.objectContaining({ forNodeId: 'for', returnNodeId: 'return', status: 'invalid_linkage' })
    );
    expect(boundaries).toHaveLength(1);
  });

  it('reports duplicate linkage edges', () => {
    const forNode = setNodeId(buildNode(for_loop), 'for');
    const returnNode = setNodeId(buildNode(for_return), 'return');

    const boundaries = getForLoopBodyBoundaries(
      [forNode, returnNode],
      [
        edge('for', 'item', 'return', 'output'),
        buildLoopLinkageEdge('for', 'return'),
        { ...buildLoopLinkageEdge('for', 'return'), id: 'duplicate-linkage' },
      ]
    );

    expect(boundaries[0]).toEqual(expect.objectContaining({ status: 'duplicate_linkage' }));
  });

  it('reports duplicate linkage ownership from multiple For nodes', () => {
    const firstForNode = setNodeId(buildNode(for_loop), 'first-for');
    const secondForNode = setNodeId(buildNode(for_loop), 'second-for');
    const returnNode = setNodeId(buildNode(for_return), 'return');

    const boundaries = getForLoopBodyBoundaries(
      [firstForNode, secondForNode, returnNode],
      [
        edge('first-for', 'item', 'return', 'output'),
        edge('second-for', 'item', 'return', 'output'),
        buildLoopLinkageEdge('first-for', 'return'),
        buildLoopLinkageEdge('second-for', 'return'),
      ]
    );

    expect(boundaries).toEqual([
      expect.objectContaining({ forNodeId: 'first-for', status: 'duplicate_linkage' }),
      expect.objectContaining({ forNodeId: 'second-for', status: 'duplicate_linkage' }),
    ]);
  });

  it('does not include final-scoped For outputs in the body boundary', () => {
    const forNode = setNodeId(buildNode(for_loop), 'for');
    const bodyNode = setNodeId(buildNode(add), 'body');
    const returnNode = setNodeId(buildNode(for_return), 'return');
    const afterNode = setNodeId(buildNode(add), 'after');

    const boundaries = getForLoopBodyBoundaries(
      [forNode, bodyNode, returnNode, afterNode],
      [
        edge('for', 'item', 'body', 'a'),
        edge('body', 'value', 'return', 'output'),
        edge('for', 'output_collection', 'after', 'a'),
        buildLoopLinkageEdge('for', 'return'),
      ]
    );

    expect(boundaries[0]?.bodyNodeIds).toEqual(['for', 'body', 'return']);
  });

  it('ignores loop linkage when finding executable paths', () => {
    const forNode = setNodeId(buildNode(for_loop), 'for');
    const bodyNode = setNodeId(buildNode(add), 'body');
    const returnNode = setNodeId(buildNode(for_return), 'return');

    const boundaries = getForLoopBodyBoundaries(
      [forNode, bodyNode, returnNode],
      [buildLoopLinkageEdge('for', 'return')]
    );

    expect(boundaries[0]).toEqual(expect.objectContaining({ status: 'invalid_linkage' }));
  });

  it('reports an unlinked ForReturn as an orphan boundary', () => {
    const returnNode = setNodeId(buildNode(for_return), 'return');

    expect(getForLoopBodyBoundaries([returnNode], [])).toEqual([
      expect.objectContaining({
        forNodeId: undefined,
        returnNodeId: 'return',
        bodyNodeIds: ['return'],
        status: 'orphan_return',
      }),
    ]);
  });
});
