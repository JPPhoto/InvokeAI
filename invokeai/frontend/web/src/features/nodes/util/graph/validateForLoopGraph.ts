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
  | 'nodes.forLoopInputCount'
  | 'nodes.forReturnInputCount'
  | 'nodes.forLoopBodyIdentityMissing'
  | 'nodes.forLoopBodyIdentityEmpty'
  | 'nodes.forLoopBodyIdentityEdge'
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

  const getBodyId = (node: unknown): string | undefined => {
    if (!node || typeof node !== 'object') {
      return undefined;
    }
    const bodyId = (node as { body_id?: unknown }).body_id;
    return typeof bodyId === 'string' && bodyId.length > 0 ? bodyId : undefined;
  };

  if (
    Object.values(nodes).some((node) => {
      if (node.type !== 'for' && node.type !== 'for_return') {
        return false;
      }
      return (node as { body_id?: unknown }).body_id === '';
    })
  ) {
    return 'nodes.forLoopBodyIdentityEmpty';
  }

  if (
    edges.some(
      (edge) =>
        edge.destination.field === 'body_id' &&
        (nodes[edge.destination.node_id]?.type === 'for' || nodes[edge.destination.node_id]?.type === 'for_return')
    )
  ) {
    return 'nodes.forLoopBodyIdentityEdge';
  }

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

  const getSupportedNestedForBody = (
    forId: string,
    reachableBodyNodeIds: Set<string>,
    reachableReturnIds: string[]
  ): { bodyPathNodeIds: Set<string>; returnId: string; innerForId: string; innerReturnId: string } | null => {
    const outerBodyId = getBodyId(nodes[forId]);
    if (outerBodyId === undefined) {
      return null;
    }
    const outerReturnIds = reachableReturnIds.filter((returnId) => getBodyId(nodes[returnId]) === outerBodyId);
    if (outerReturnIds.length !== 1) {
      return null;
    }
    const outerReturnId = outerReturnIds[0];
    if (outerReturnId === undefined) {
      return null;
    }

    const innerForIds = [...reachableBodyNodeIds].filter((nodeId) => nodes[nodeId]?.type === 'for');
    const directInnerForIds = innerForIds.filter(
      (innerForId) =>
        !innerForIds.some(
          (otherInnerForId) => otherInnerForId !== innerForId && hasPath(otherInnerForId, innerForId)
        )
    );
    if (directInnerForIds.length !== 1) {
      return null;
    }
    const innerForId = directInnerForIds[0];
    if (innerForId === undefined || getBodyId(nodes[innerForId]) === undefined) {
      return null;
    }

    const innerIterationEdges = edges.filter(
      (edge) => edge.source.node_id === innerForId && ITERATION_OUTPUT_FIELDS.has(edge.source.field)
    );
    if (innerIterationEdges.length === 0) {
      return null;
    }
    const innerReachableBodyNodeIds = walk(
      innerIterationEdges.map((edge) => edge.destination.node_id),
      outgoing
    );
    const innerReachableReturnIds = [...innerReachableBodyNodeIds].filter(
      (nodeId) => nodes[nodeId]?.type === 'for_return'
    );
    const innerBodyId = getBodyId(nodes[innerForId]);
    const innerReturnIds = innerReachableReturnIds.filter((returnId) => getBodyId(nodes[returnId]) === innerBodyId);
    if (innerReturnIds.length !== 1) {
      return null;
    }
    const innerReturnId = innerReturnIds[0];
    if (innerReturnId === undefined || !reachableReturnIds.includes(innerReturnId)) {
      return null;
    }

    const innerReturnAncestors = walk([innerReturnId], incoming);
    const innerBodyPathNodeIds = new Set(
      [...innerReachableBodyNodeIds].filter((nodeId) => nodeId === innerReturnId || innerReturnAncestors.has(nodeId))
    );
    innerBodyPathNodeIds.add(innerReturnId);
    const innerNestedForIds = [...innerBodyPathNodeIds].filter((nodeId) => nodes[nodeId]?.type === 'for');
    if ([...innerBodyPathNodeIds].some((nodeId) => nodes[nodeId]?.type === 'iterate')) {
      return null;
    }
    const innerNestedBody =
      innerNestedForIds.length > 0
        ? getSupportedNestedForBody(innerForId, innerReachableBodyNodeIds, innerReachableReturnIds)
        : null;
    if (innerNestedForIds.length > 0 && innerNestedBody === null) {
      return null;
    }
    if (innerNestedBody !== null) {
      for (const bodyNodeId of innerNestedBody.bodyPathNodeIds) {
        innerBodyPathNodeIds.add(bodyNodeId);
      }
    }
    if (
      new Set(reachableReturnIds.filter((returnId) => !innerBodyPathNodeIds.has(returnId))).size !== 1 ||
      !reachableReturnIds.includes(outerReturnId)
    ) {
      return null;
    }

    const innerCollectionEdges = edges.filter(
      (edge) => edge.destination.node_id === innerForId && edge.destination.field === 'collection'
    );
    const innerCollectionSourceId = innerCollectionEdges[0]?.source.node_id;
    if (
      innerCollectionEdges.length !== 1 ||
      innerCollectionSourceId === undefined ||
      (innerCollectionSourceId !== forId && !reachableBodyNodeIds.has(innerCollectionSourceId))
    ) {
      return null;
    }

    const outerReturnOutputEdges = edges.filter(
      (edge) => edge.destination.node_id === outerReturnId && edge.destination.field === 'output'
    );
    if (
      outerReturnOutputEdges.length !== 1 ||
      outerReturnOutputEdges[0]?.source.node_id !== innerForId ||
      outerReturnOutputEdges[0]?.source.field !== 'output_collection'
    ) {
      return null;
    }
    const unsupportedOuterReturnInput = edges.some(
      (edge) =>
        edge.destination.node_id === outerReturnId &&
        edge.destination.field !== 'output' &&
        (edge.destination.field !== 'state' || edge.source.node_id !== forId || edge.source.field !== 'state')
    );
    if (unsupportedOuterReturnInput) {
      return null;
    }

    const outerPreparationNodeIds = new Set(
      [...reachableBodyNodeIds].filter((nodeId) => walk([innerForId], incoming).has(nodeId))
    );
    outerPreparationNodeIds.add(innerForId);
    const bodyPathNodeIds = new Set([...outerPreparationNodeIds, ...innerBodyPathNodeIds, outerReturnId]);
    if ([...reachableBodyNodeIds].some((nodeId) => !bodyPathNodeIds.has(nodeId))) {
      return null;
    }
    if (
      [...outerPreparationNodeIds].some(
        (nodeId) => nodeId !== innerForId && (nodes[nodeId]?.type === 'for' || nodes[nodeId]?.type === 'iterate')
      )
    ) {
      return null;
    }
    for (const bodyNodeId of outerPreparationNodeIds) {
      if (bodyNodeId === innerForId || innerBodyPathNodeIds.has(bodyNodeId)) {
        continue;
      }
      if (!hasPath(bodyNodeId, innerForId)) {
        return null;
      }
    }

    const unsupportedInnerReturnInput = edges.some(
      (edge) =>
        edge.destination.node_id === innerReturnId &&
        edge.destination.field !== 'output' &&
        (edge.destination.field !== 'state' || edge.source.node_id !== innerForId || edge.source.field !== 'state')
    );
    if (unsupportedInnerReturnInput) {
      return null;
    }

    return { bodyPathNodeIds, returnId: outerReturnId, innerForId, innerReturnId };
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
      const identityMatchingReturnIds =
        bodyId === undefined ? [] : reachableReturnIds.filter((returnId) => getBodyId(nodes[returnId]) === bodyId);
      const returnId = identityMatchingReturnIds.length === 1 ? identityMatchingReturnIds[0] : reachableReturnIds[0];
      if (returnId !== undefined && (reachableReturnIds.length === 1 || identityMatchingReturnIds.length === 1)) {
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
    if (
      edges.filter((edge) => edge.destination.node_id === node.id && edge.destination.field === 'collection').length >
        1 ||
      edges.filter((edge) => edge.destination.node_id === node.id && edge.destination.field === 'state').length > 1
    ) {
      return 'nodes.forLoopInputCount';
    }
    if (iterationEdges.length === 0) {
      return 'nodes.forLoopMissingIterationOutput';
    }

    const reachableBodyNodeIds = walk(
      iterationEdges.map((edge) => edge.destination.node_id),
      outgoing
    );
    const reachableReturnIds = [...reachableBodyNodeIds].filter((nodeId) => nodes[nodeId]?.type === 'for_return');
    const nestedForNodeIds = [...reachableBodyNodeIds].filter(
      (nodeId) =>
        nodeId !== node.id &&
        nodes[nodeId]?.type === 'for' &&
        ![...reachableBodyNodeIds].some(
          (otherNodeId) =>
            otherNodeId !== nodeId &&
            nodes[otherNodeId]?.type === 'for' &&
            hasPath(otherNodeId, nodeId)
        )
    );
    const nestedBody =
      nestedForNodeIds.length > 0 ? getSupportedNestedForBody(node.id, reachableBodyNodeIds, reachableReturnIds) : null;
    if (nestedForNodeIds.length > 0 && nestedBody === null) {
      return 'nodes.forLoopNestedUnsupported';
    }

    if (nestedBody === null && reachableReturnIds.length !== 1) {
      return 'nodes.forLoopReturnCount';
    }

    const returnId = nestedBody?.returnId ?? reachableReturnIds[0];
    if (returnId === undefined) {
      return 'nodes.forLoopReturnCount';
    }
    matchingForIdsByReturnId.set(returnId, [...(matchingForIdsByReturnId.get(returnId) ?? []), node.id]);

    const bodyPathNodeIds =
      nestedBody?.bodyPathNodeIds ??
      (() => {
        const returnAncestorIds = walk(incoming.get(returnId) ?? [], incoming);
        const path = new Set(
          [...reachableBodyNodeIds].filter((nodeId) => nodeId === returnId || returnAncestorIds.has(nodeId))
        );
        path.add(returnId);
        return path;
      })();

    if ([...reachableBodyNodeIds].some((nodeId) => !bodyPathNodeIds.has(nodeId))) {
      return 'nodes.forLoopUnterminatedBody';
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
    if (
      node.type === 'for_return' &&
      (edges.filter((edge) => edge.destination.node_id === node.id && edge.destination.field === 'output').length > 1 ||
        edges.filter((edge) => edge.destination.node_id === node.id && edge.destination.field === 'state').length > 1)
    ) {
      return 'nodes.forReturnInputCount';
    }
  }

  return null;
};
