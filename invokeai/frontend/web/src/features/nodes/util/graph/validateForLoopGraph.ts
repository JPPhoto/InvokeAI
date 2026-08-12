import type { Graph } from 'services/api/types';

type ForLoopGraphError =
  | 'nodes.forLoopMissingIterationOutput'
  | 'nodes.forLoopReturnCount'
  | 'nodes.forLoopUnterminatedBody'
  | 'nodes.forLoopNestedUnsupported'
  | 'nodes.forLoopIterateUnsupported'
  | 'nodes.forLoopIteratorInputUnsupported'
  | 'nodes.forLoopFinalOutputInBody'
  | 'nodes.forLoopBodyEscape'
  | 'nodes.forLoopBodyIdentityMissing'
  | 'nodes.forLoopBodyIdentityStale'
  | 'nodes.forLoopBodyIdentityDuplicate'
  | 'nodes.forLoopBodyIdentityMismatch'
  | 'nodes.forReturnOwnership';

const ITERATION_OUTPUT_FIELDS = new Set(['item', 'index', 'total', 'state']);
const FINAL_OUTPUT_FIELDS = new Set(['output_collection', 'final_state']);

export const validateForLoopGraph = (graph: Graph): ForLoopGraphError | null => {
  const nodes = graph.nodes ?? {};
  const edges = graph.edges ?? [];
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();

  for (const edge of edges) {
    const sourceId = edge.source.node_id;
    const destinationId = edge.destination.node_id;
    outgoing.set(sourceId, [...(outgoing.get(sourceId) ?? []), destinationId]);
    incoming.set(destinationId, [...(incoming.get(destinationId) ?? []), sourceId]);
  }

  const walk = (startIds: Iterable<string>, adjacency: Map<string, string[]>): Set<string> => {
    const visited = new Set<string>();
    const pending = [...startIds];
    while (pending.length > 0) {
      const nodeId = pending.pop();
      if (nodeId === undefined || visited.has(nodeId)) {
        continue;
      }
      visited.add(nodeId);
      pending.push(...(adjacency.get(nodeId) ?? []));
    }
    return visited;
  };

  const hasPath = (startId: string, targetId: string): boolean =>
    startId === targetId || walk([startId], outgoing).has(targetId);

  const supportsNestedIterateBody = (
    bodyPathNodeIds: Set<string>,
    iterateNodeIds: string[],
    collectNodeIds: string[],
    returnId: string,
    forId: string
  ): boolean => {
    if (iterateNodeIds.length !== 1 || collectNodeIds.length !== 1) {
      return false;
    }

    const iterateId = iterateNodeIds[0];
    const collectId = collectNodeIds[0];
    if (iterateId === undefined || collectId === undefined || !hasPath(iterateId, collectId)) {
      return false;
    }

    const iterateCollectionEdges = edges.filter(
      (edge) => edge.destination.node_id === iterateId && edge.destination.field === 'collection'
    );
    const iterateCollectionSourceId = iterateCollectionEdges[0]?.source.node_id;
    if (
      iterateCollectionEdges.length !== 1 ||
      iterateCollectionSourceId === undefined ||
      (iterateCollectionSourceId !== forId && !bodyPathNodeIds.has(iterateCollectionSourceId))
    ) {
      return false;
    }

    const returnOutputEdges = edges.filter(
      (edge) => edge.destination.node_id === returnId && edge.destination.field === 'output'
    );
    if (
      returnOutputEdges.length !== 1 ||
      returnOutputEdges[0]?.source.node_id !== collectId ||
      returnOutputEdges[0]?.source.field !== 'collection'
    ) {
      return false;
    }

    const unsupportedReturnInput = edges.some(
      (edge) =>
        edge.destination.node_id === returnId &&
        edge.destination.field !== 'output' &&
        (edge.destination.field !== 'state' || edge.source.node_id !== forId || edge.source.field !== 'state')
    );
    if (unsupportedReturnInput) {
      return false;
    }

    const collectCollectionEdges = edges.filter(
      (edge) => edge.destination.node_id === collectId && edge.destination.field === 'collection'
    );
    const collectItemEdges = edges.filter(
      (edge) => edge.destination.node_id === collectId && edge.destination.field === 'item'
    );
    if (collectCollectionEdges.length !== 0 || collectItemEdges.length !== 1) {
      return false;
    }
    const collectItemSourceId = collectItemEdges[0]?.source.node_id;
    if (collectItemSourceId === undefined || !hasPath(iterateId, collectItemSourceId)) {
      return false;
    }

    for (const bodyNodeId of bodyPathNodeIds) {
      if (bodyNodeId === iterateId || bodyNodeId === collectId || bodyNodeId === returnId) {
        continue;
      }
      if (!hasPath(bodyNodeId, collectId) || (!hasPath(bodyNodeId, iterateId) && !hasPath(iterateId, bodyNodeId))) {
        return false;
      }
    }

    return true;
  };

  const getBodyId = (node: unknown): string | undefined => {
    if (!node || typeof node !== 'object') {
      return undefined;
    }
    const bodyId = (node as { body_id?: unknown }).body_id;
    return typeof bodyId === 'string' && bodyId.length > 0 ? bodyId : undefined;
  };

  const forIdentityNodes = new Map<string, string[]>();
  const returnIdentityNodes = new Map<string, string[]>();
  const matchingReturnByForId = new Map<string, string>();
  const identityMatchingForIdsByReturnId = new Map<string, string[]>();
  for (const node of Object.values(nodes)) {
    if (node.type === 'for') {
      const bodyId = getBodyId(node);
      if (bodyId !== undefined) {
        forIdentityNodes.set(bodyId, [...(forIdentityNodes.get(bodyId) ?? []), node.id]);
      }

      const iterationEdges = edges.filter(
        (edge) => edge.source.node_id === node.id && ITERATION_OUTPUT_FIELDS.has(edge.source.field)
      );
      if (iterationEdges.length === 0) {
        continue;
      }
      const reachableBodyNodeIds = walk(
        iterationEdges.map((edge) => edge.destination.node_id),
        outgoing
      );
      const reachableReturnIds = [...reachableBodyNodeIds].filter((nodeId) => nodes[nodeId]?.type === 'for_return');
      if (reachableReturnIds.length === 1) {
        const returnId = reachableReturnIds[0];
        if (returnId !== undefined) {
          matchingReturnByForId.set(node.id, returnId);
          identityMatchingForIdsByReturnId.set(returnId, [
            ...(identityMatchingForIdsByReturnId.get(returnId) ?? []),
            node.id,
          ]);
        }
      }
    }
    if (node.type === 'for_return') {
      const bodyId = getBodyId(node);
      if (bodyId !== undefined) {
        returnIdentityNodes.set(bodyId, [...(returnIdentityNodes.get(bodyId) ?? []), node.id]);
      }
    }
  }

  if ([...forIdentityNodes.values()].some((nodeIds) => nodeIds.length > 1)) {
    return 'nodes.forLoopBodyIdentityDuplicate';
  }
  if ([...returnIdentityNodes.values()].some((nodeIds) => nodeIds.length > 1)) {
    return 'nodes.forLoopBodyIdentityDuplicate';
  }

  for (const node of Object.values(nodes)) {
    if (node.type !== 'for_return') {
      continue;
    }
    const bodyId = getBodyId(node);
    if (bodyId === undefined) {
      continue;
    }
    const matchingForIds = identityMatchingForIdsByReturnId.get(node.id) ?? [];
    if (matchingForIds.length === 1) {
      const matchingFor = nodes[matchingForIds[0] ?? ''];
      if (getBodyId(matchingFor) === undefined) {
        return 'nodes.forLoopBodyIdentityMissing';
      }
      if (getBodyId(matchingFor) !== bodyId) {
        return 'nodes.forLoopBodyIdentityMismatch';
      }
    } else if (!forIdentityNodes.has(bodyId)) {
      return 'nodes.forLoopBodyIdentityStale';
    }
  }

  for (const node of Object.values(nodes)) {
    if (node.type !== 'for') {
      continue;
    }
    const bodyId = getBodyId(node);
    const returnId = matchingReturnByForId.get(node.id);
    if (bodyId === undefined || returnId === undefined) {
      continue;
    }
    const matchingReturn = nodes[returnId];
    const returnBodyId = getBodyId(matchingReturn);
    if (returnBodyId === undefined) {
      return 'nodes.forLoopBodyIdentityMissing';
    }
    if (returnBodyId !== bodyId) {
      return 'nodes.forLoopBodyIdentityMismatch';
    }
  }

  const matchingForIdsByReturnId = new Map<string, string[]>();

  for (const node of Object.values(nodes)) {
    if (node.type !== 'for') {
      continue;
    }

    const iterationEdges = edges.filter(
      (edge) => edge.source.node_id === node.id && ITERATION_OUTPUT_FIELDS.has(edge.source.field)
    );
    if (iterationEdges.length === 0) {
      return 'nodes.forLoopMissingIterationOutput';
    }

    const reachableBodyNodeIds = walk(
      iterationEdges.map((edge) => edge.destination.node_id),
      outgoing
    );
    const reachableReturnIds = [...reachableBodyNodeIds].filter((nodeId) => nodes[nodeId]?.type === 'for_return');
    if (reachableReturnIds.length !== 1) {
      return 'nodes.forLoopReturnCount';
    }

    const returnId = reachableReturnIds[0];
    if (returnId === undefined) {
      return 'nodes.forLoopReturnCount';
    }
    matchingForIdsByReturnId.set(returnId, [...(matchingForIdsByReturnId.get(returnId) ?? []), node.id]);

    const returnAncestorIds = walk(incoming.get(returnId) ?? [], incoming);
    const bodyPathNodeIds = new Set(
      [...reachableBodyNodeIds].filter((nodeId) => nodeId === returnId || returnAncestorIds.has(nodeId))
    );
    bodyPathNodeIds.add(returnId);

    if ([...reachableBodyNodeIds].some((nodeId) => !bodyPathNodeIds.has(nodeId))) {
      return 'nodes.forLoopUnterminatedBody';
    }

    if ([...bodyPathNodeIds].some((nodeId) => nodeId !== node.id && nodes[nodeId]?.type === 'for')) {
      return 'nodes.forLoopNestedUnsupported';
    }

    const iterateNodeIds = [...bodyPathNodeIds].filter((nodeId) => nodes[nodeId]?.type === 'iterate');
    if (
      iterateNodeIds.length > 0 &&
      !supportsNestedIterateBody(
        bodyPathNodeIds,
        iterateNodeIds,
        [...bodyPathNodeIds].filter((nodeId) => nodes[nodeId]?.type === 'collect'),
        returnId,
        node.id
      )
    ) {
      return 'nodes.forLoopIterateUnsupported';
    }

    for (const bodyNodeId of bodyPathNodeIds) {
      for (const sourceId of incoming.get(bodyNodeId) ?? []) {
        if (sourceId === node.id || bodyPathNodeIds.has(sourceId)) {
          continue;
        }
        const activeSourceIds = walk([sourceId], incoming);
        if ([...activeSourceIds].some((sourceNodeId) => nodes[sourceNodeId]?.type === 'iterate')) {
          return 'nodes.forLoopIteratorInputUnsupported';
        }
      }
    }

    if (
      edges.some(
        (edge) =>
          edge.source.node_id === node.id &&
          FINAL_OUTPUT_FIELDS.has(edge.source.field) &&
          bodyPathNodeIds.has(edge.destination.node_id)
      )
    ) {
      return 'nodes.forLoopFinalOutputInBody';
    }

    for (const bodyNodeId of bodyPathNodeIds) {
      if (bodyNodeId === returnId) {
        continue;
      }
      if ((outgoing.get(bodyNodeId) ?? []).some((destinationId) => !bodyPathNodeIds.has(destinationId))) {
        return 'nodes.forLoopBodyEscape';
      }
    }
  }

  for (const node of Object.values(nodes)) {
    if (node.type === 'for_return' && matchingForIdsByReturnId.get(node.id)?.length !== 1) {
      return 'nodes.forReturnOwnership';
    }
  }

  return null;
};
