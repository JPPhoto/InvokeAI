import { getLoopBodyIdentity } from 'features/nodes/store/util/loopIdentity';
import { add, buildEdge, buildNode, for_loop, for_return } from 'features/nodes/store/util/testUtils';
import type { AnyEdge, AnyNode } from 'features/nodes/types/invocation';
import { describe, expect, it } from 'vitest';

import { getForLoopBodyBoundaries, reconcileForLoopBodyIdentities } from './loopBodyBoundary';

const setBodyId = (node: AnyNode, bodyId: string | undefined) => {
  if (node.type !== 'invocation' || !node.data.inputs.body_id) {
    throw new Error('Expected a loop boundary node');
  }
  node.data.inputs.body_id.value = bodyId;
};

const setNodeId = (node: AnyNode, id: string): AnyNode => {
  node.id = id;
  node.data.id = id;
  return node;
};

const edge = (source: string, sourceHandle: string, target: string, targetHandle: string): AnyEdge =>
  buildEdge(source, sourceHandle, target, targetHandle);

describe(getForLoopBodyBoundaries.name, () => {
  it('assigns a shared identity for a body connected through state', () => {
    const forNode = setNodeId(buildNode(for_loop), 'for');
    const returnNode = setNodeId(buildNode(for_return), 'return');

    reconcileForLoopBodyIdentities([forNode, returnNode], [edge('for', 'state', 'return', 'state')], () => 'body-1');

    expect(getLoopBodyIdentity(forNode)).toBe('body-1');
    expect(getLoopBodyIdentity(returnNode)).toBe('body-1');
  });

  it('propagates an existing For identity to a newly linked ForReturn', () => {
    const forNode = setNodeId(buildNode(for_loop), 'for');
    const returnNode = setNodeId(buildNode(for_return), 'return');
    setBodyId(forNode, 'body-1');

    reconcileForLoopBodyIdentities([forNode, returnNode], [edge('for', 'state', 'return', 'state')]);

    expect(getLoopBodyIdentity(returnNode)).toBe('body-1');
  });

  it('does not reuse a For identity claimed by a detached ForReturn', () => {
    const forNode = setNodeId(buildNode(for_loop), 'for');
    const returnNode = setNodeId(buildNode(for_return), 'return');
    const detachedReturnNode = setNodeId(buildNode(for_return), 'detached-return');
    setBodyId(forNode, 'body-1');
    setBodyId(detachedReturnNode, 'body-1');

    reconcileForLoopBodyIdentities(
      [forNode, returnNode, detachedReturnNode],
      [edge('for', 'state', 'return', 'state')]
    );

    expect(getLoopBodyIdentity(forNode)).toBe('body-1');
    expect(getLoopBodyIdentity(returnNode)).toBeUndefined();
    expect(getLoopBodyIdentity(detachedReturnNode)).toBe('body-1');
  });

  it('does not adopt an identity that exists only on ForReturn', () => {
    const forNode = setNodeId(buildNode(for_loop), 'for');
    const returnNode = setNodeId(buildNode(for_return), 'return');
    setBodyId(returnNode, 'body-1');

    reconcileForLoopBodyIdentities([forNode, returnNode], [edge('for', 'state', 'return', 'state')]);

    expect(getLoopBodyIdentity(forNode)).toBeUndefined();
    expect(getLoopBodyIdentity(returnNode)).toBe('body-1');
  });

  it('does not assign an identity when multiple For nodes share one return', () => {
    const firstForNode = setNodeId(buildNode(for_loop), 'first-for');
    const secondForNode = setNodeId(buildNode(for_loop), 'second-for');
    const returnNode = setNodeId(buildNode(for_return), 'return');

    reconcileForLoopBodyIdentities(
      [firstForNode, secondForNode, returnNode],
      [edge('first-for', 'state', 'return', 'state'), edge('second-for', 'state', 'return', 'state')],
      () => 'body-1'
    );

    expect(getLoopBodyIdentity(firstForNode)).toBeUndefined();
    expect(getLoopBodyIdentity(secondForNode)).toBeUndefined();
    expect(getLoopBodyIdentity(returnNode)).toBeUndefined();
  });

  it('resolves a legacy body from For iteration outputs to one ForReturn', () => {
    const forNode = setNodeId(buildNode(for_loop), 'for');
    const bodyNode = setNodeId(buildNode(add), 'body');
    const returnNode = setNodeId(buildNode(for_return), 'return');

    const boundaries = getForLoopBodyBoundaries(
      [forNode, bodyNode, returnNode],
      [edge('for', 'item', 'body', 'collection'), edge('body', 'item', 'return', 'output')]
    );

    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]).toEqual(
      expect.objectContaining({
        forNodeId: 'for',
        returnNodeId: 'return',
        bodyNodeIds: ['for', 'body', 'return'],
        status: 'complete',
      })
    );
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
      ]
    );

    expect(boundaries[0]?.bodyNodeIds).toEqual(['for', 'body', 'return']);
  });

  it('ignores collapsed dummy edges when resolving the body path', () => {
    const forNode = setNodeId(buildNode(for_loop), 'for');
    const bodyNode = setNodeId(buildNode(add), 'body');
    const returnNode = setNodeId(buildNode(for_return), 'return');
    const collapsedEdge = {
      id: 'body-return-collapsed',
      source: 'body',
      target: 'return',
      type: 'collapsed',
      data: { count: 1 },
    } as AnyEdge;

    const boundaries = getForLoopBodyBoundaries(
      [forNode, bodyNode, returnNode],
      [edge('for', 'item', 'body', 'collection'), collapsedEdge]
    );

    expect(boundaries[0]).toEqual(
      expect.objectContaining({
        forNodeId: 'for',
        bodyNodeIds: ['for', 'body'],
        status: 'missing_return',
      })
    );
  });

  it('uses durable identity to choose the matching return on a nested path', () => {
    const forNode = setNodeId(buildNode(for_loop), 'outer');
    const innerForNode = setNodeId(buildNode(for_loop), 'inner');
    const innerReturnNode = setNodeId(buildNode(for_return), 'inner-return');
    const outerReturnNode = setNodeId(buildNode(for_return), 'outer-return');
    setBodyId(forNode, 'outer-body');
    setBodyId(innerForNode, 'inner-body');
    setBodyId(innerReturnNode, 'inner-body');
    setBodyId(outerReturnNode, 'outer-body');

    const boundaries = getForLoopBodyBoundaries(
      [forNode, innerForNode, innerReturnNode, outerReturnNode],
      [
        edge('outer', 'item', 'inner', 'collection'),
        edge('inner', 'item', 'inner-return', 'output'),
        edge('inner', 'output_collection', 'outer-return', 'output'),
      ]
    );

    expect(boundaries).toEqual([
      expect.objectContaining({ forNodeId: 'outer', returnNodeId: 'outer-return', status: 'complete' }),
      expect.objectContaining({ forNodeId: 'inner', returnNodeId: 'inner-return', status: 'complete' }),
    ]);
  });

  it.each([
    ['missing_return', []],
    [
      'multiple_returns',
      [edge('body', 'item', 'first-return', 'output'), edge('body', 'item', 'second-return', 'output')],
    ],
  ] as const)('reports an incomplete legacy body as %s', (status, returnEdges) => {
    const forNode = setNodeId(buildNode(for_loop), 'for');
    const bodyNode = setNodeId(buildNode(add), 'body');
    const firstReturnNode = setNodeId(buildNode(for_return), 'first-return');
    const secondReturnNode = setNodeId(buildNode(for_return), 'second-return');
    const nodes = [forNode, bodyNode, firstReturnNode, secondReturnNode];
    const edges = [edge('for', 'item', 'body', 'collection'), ...returnEdges];

    const boundaries = getForLoopBodyBoundaries(nodes, edges);
    expect(boundaries[0]).toEqual(expect.objectContaining({ forNodeId: 'for', status }));
  });

  it.each([
    ['identity_empty', '', 'body-1', []],
    ['identity_missing', undefined, 'body-1', []],
    ['identity_mismatch', 'body-1', 'body-2', []],
    ['duplicate_identity', 'body-1', 'body-1', ['duplicate']],
  ] as const)('reports durable identity status %s', (status, forBodyId, returnBodyId, extraNodes) => {
    const forNode = setNodeId(buildNode(for_loop), 'for');
    const returnNode = setNodeId(buildNode(for_return), 'return');
    setBodyId(forNode, forBodyId);
    setBodyId(returnNode, returnBodyId);

    const nodes = [forNode, returnNode];
    if (extraNodes[0] === 'duplicate') {
      const duplicateReturnNode = setNodeId(buildNode(for_return), 'duplicate-return');
      setBodyId(duplicateReturnNode, returnBodyId);
      nodes.push(duplicateReturnNode);
    }

    const boundaries = getForLoopBodyBoundaries(nodes, [edge('for', 'item', 'return', 'output')]);

    expect(boundaries[0]).toEqual(expect.objectContaining({ forNodeId: 'for', status }));
  });

  it('reports a durable identity whose matching return is detached from the body', () => {
    const forNode = setNodeId(buildNode(for_loop), 'for');
    const bodyNode = setNodeId(buildNode(add), 'body');
    const detachedReturnNode = setNodeId(buildNode(for_return), 'detached-return');
    setBodyId(forNode, 'body-1');
    setBodyId(detachedReturnNode, 'body-1');

    const boundaries = getForLoopBodyBoundaries(
      [forNode, bodyNode, detachedReturnNode],
      [edge('for', 'item', 'body', 'a')]
    );

    expect(boundaries[0]).toEqual(expect.objectContaining({ forNodeId: 'for', status: 'stale_identity' }));
  });

  it('reports an orphan ForReturn identity as a standalone diagnostic boundary', () => {
    const returnNode = setNodeId(buildNode(for_return), 'return');
    setBodyId(returnNode, 'missing-for');

    expect(getForLoopBodyBoundaries([returnNode], [])).toEqual([
      expect.objectContaining({
        forNodeId: undefined,
        returnNodeId: 'return',
        bodyNodeIds: ['return'],
        bodyId: 'missing-for',
        status: 'stale_identity',
      }),
    ]);
  });
});
