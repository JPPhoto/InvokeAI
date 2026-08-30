import { LOOP_LINKAGE_FIELD } from 'features/nodes/types/constants';
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
  | 'nodes.forLoopLinkageMissing'
  | 'nodes.forLoopLinkageInvalid'
  | 'nodes.forLoopLinkageDuplicate'
  | 'nodes.forReturnOwnership';

const ITERATION_OUTPUT_FIELDS = new Set(['item', 'index', 'total', 'state']);
const FINAL_OUTPUT_FIELDS = new Set(['output_collection', 'final_state']);

export const validateForLoopGraph = (graph: Graph): ForLoopGraphError | null => {
  const nodes = graph.nodes ?? {};
  const allEdges = graph.edges ?? [];
  const edges = allEdges.filter((edge) => edge.type !== 'loop_linkage');
  const linkageEdges = allEdges.filter((edge) => edge.type === 'loop_linkage');
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

  const linkedReturnByForId = new Map<string, string>();
  const linkedForByReturnId = new Map<string, string>();
  for (const edge of linkageEdges) {
    const sourceNode = nodes[edge.source.node_id];
    const destinationNode = nodes[edge.destination.node_id];
    if (
      edge.source.field !== LOOP_LINKAGE_FIELD ||
      edge.destination.field !== LOOP_LINKAGE_FIELD ||
      sourceNode?.type !== 'for' ||
      destinationNode?.type !== 'for_return'
    ) {
      return 'nodes.forLoopLinkageInvalid';
    }
    if (linkedReturnByForId.has(edge.source.node_id) || linkedForByReturnId.has(edge.destination.node_id)) {
      return 'nodes.forLoopLinkageDuplicate';
    }
    linkedReturnByForId.set(edge.source.node_id, edge.destination.node_id);
    linkedForByReturnId.set(edge.destination.node_id, edge.source.node_id);
  }

  if (
    Object.values(nodes).some((node) => {
      if (node.type === 'for') {
        return !linkedReturnByForId.has(node.id);
      }
      if (node.type === 'for_return') {
        return !linkedForByReturnId.has(node.id);
      }
      return false;
    })
  ) {
    return 'nodes.forLoopLinkageMissing';
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
        edge.destination.field !== 'continue_condition' &&
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
      if (!hasPath(bodyNodeId, collectId)) {
        return false;
      }
      if (!hasPath(bodyNodeId, iterateId) && !hasPath(iterateId, bodyNodeId)) {
        return false;
      }
    }

    return true;
  };

  const getSupportedNestedForBody = (
    forId: string,
    reachableBodyNodeIds: Set<string>,
    reachableReturnIds: string[]
  ): { bodyPathNodeIds: Set<string>; returnId: string } | null => {
    const outerReturnId = linkedReturnByForId.get(forId);
    if (outerReturnId === undefined || !reachableReturnIds.includes(outerReturnId)) {
      return null;
    }

    const innerForIds = [...reachableBodyNodeIds].filter((nodeId) => nodes[nodeId]?.type === 'for');
    const directInnerForIds = innerForIds.filter(
      (innerForId) =>
        !innerForIds.some((otherInnerForId) => otherInnerForId !== innerForId && hasPath(otherInnerForId, innerForId))
    );
    if (directInnerForIds.length === 0) {
      return null;
    }
    const innerBodyPathNodeIds = new Set<string>();

    for (const innerForId of directInnerForIds) {
      if (innerForId === undefined) {
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
      const innerReturnId = linkedReturnByForId.get(innerForId);
      if (innerReturnId === undefined || !innerReachableReturnIds.includes(innerReturnId)) {
        return null;
      }

      const innerReturnAncestors = walk([innerReturnId], incoming);
      const childBodyPathNodeIds = new Set(
        [...innerReachableBodyNodeIds].filter((nodeId) => nodeId === innerReturnId || innerReturnAncestors.has(nodeId))
      );
      childBodyPathNodeIds.add(innerReturnId);
      const innerNestedForIds = [...childBodyPathNodeIds].filter((nodeId) => nodes[nodeId]?.type === 'for');
      if ([...childBodyPathNodeIds].some((nodeId) => nodes[nodeId]?.type === 'iterate')) {
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
          childBodyPathNodeIds.add(bodyNodeId);
        }
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

      const unsupportedInnerReturnInput = edges.some(
        (edge) =>
          edge.destination.node_id === innerReturnId &&
          edge.destination.field === 'state' &&
          edge.source.node_id !== innerForId &&
          !childBodyPathNodeIds.has(edge.source.node_id)
      );
      if (unsupportedInnerReturnInput) {
        return null;
      }

      for (const bodyNodeId of childBodyPathNodeIds) {
        innerBodyPathNodeIds.add(bodyNodeId);
      }
    }
    if (
      new Set(reachableReturnIds.filter((returnId) => !innerBodyPathNodeIds.has(returnId))).size !== 1 ||
      !reachableReturnIds.includes(outerReturnId)
    ) {
      return null;
    }

    const outerReturnOutputEdges = edges.filter(
      (edge) => edge.destination.node_id === outerReturnId && edge.destination.field === 'output'
    );
    if (outerReturnOutputEdges.length !== 1) {
      return null;
    }
    const unsupportedOuterReturnInput = edges.some(
      (edge) =>
        edge.destination.node_id === outerReturnId &&
        edge.destination.field !== 'output' &&
        edge.destination.field !== 'continue_condition' &&
        (edge.destination.field !== 'state' || edge.source.node_id !== forId || edge.source.field !== 'state')
    );
    if (unsupportedOuterReturnInput) {
      return null;
    }

    const outerPreparationNodeIds = new Set<string>();
    for (const innerForId of directInnerForIds) {
      for (const bodyNodeId of reachableBodyNodeIds) {
        if (walk([innerForId], incoming).has(bodyNodeId)) {
          outerPreparationNodeIds.add(bodyNodeId);
        }
      }
      outerPreparationNodeIds.add(innerForId);
    }
    const innerFinalDescendantNodeIds = new Set<string>();
    for (const innerForId of directInnerForIds) {
      for (const destinationId of edges
        .filter((edge) => edge.source.node_id === innerForId && edge.source.field === 'output_collection')
        .map((edge) => edge.destination.node_id)) {
        for (const descendantId of walk([destinationId], outgoing)) {
          innerFinalDescendantNodeIds.add(descendantId);
        }
      }
    }
    const continuationNodeIds = new Set(
      [...reachableBodyNodeIds].filter(
        (nodeId) =>
          !outerPreparationNodeIds.has(nodeId) && !innerBodyPathNodeIds.has(nodeId) && nodeId !== outerReturnId
      )
    );
    if (
      edges.some(
        (edge) =>
          edge.destination.node_id === outerReturnId &&
          edge.destination.field === 'continue_condition' &&
          edge.source.node_id !== forId &&
          !continuationNodeIds.has(edge.source.node_id) &&
          !(directInnerForIds.includes(edge.source.node_id) && FINAL_OUTPUT_FIELDS.has(edge.source.field))
      )
    ) {
      return null;
    }
    if ([...continuationNodeIds].some((nodeId) => !innerFinalDescendantNodeIds.has(nodeId))) {
      return null;
    }
    if ([...continuationNodeIds].some((nodeId) => !hasPath(nodeId, outerReturnId))) {
      return null;
    }
    if (
      [...continuationNodeIds].some(
        (nodeId) =>
          nodes[nodeId]?.type === 'for' || nodes[nodeId]?.type === 'iterate' || nodes[nodeId]?.type === 'for_return'
      )
    ) {
      return null;
    }
    if (
      [...continuationNodeIds].some((nodeId) =>
        edges.some(
          (edge) =>
            edge.destination.node_id === nodeId &&
            (innerBodyPathNodeIds.has(edge.source.node_id) ||
              (directInnerForIds.includes(edge.source.node_id) && edge.source.field !== 'output_collection'))
        )
      )
    ) {
      return null;
    }
    const outerReturnOutputSource = outerReturnOutputEdges[0]?.source;
    if (outerReturnOutputSource !== undefined && directInnerForIds.includes(outerReturnOutputSource.node_id)) {
      if (
        directInnerForIds.length !== 1 ||
        outerReturnOutputSource.field !== 'output_collection' ||
        continuationNodeIds.size > 0
      ) {
        return null;
      }
    } else if (outerReturnOutputSource === undefined || !continuationNodeIds.has(outerReturnOutputSource.node_id)) {
      return null;
    }

    if (
      directInnerForIds.some(
        (innerForId) =>
          !edges
            .filter((edge) => edge.source.node_id === innerForId && FINAL_OUTPUT_FIELDS.has(edge.source.field))
            .some(
              (edge) => continuationNodeIds.has(edge.destination.node_id) || edge.destination.node_id === outerReturnId
            )
      )
    ) {
      return null;
    }

    const bodyPathNodeIds = new Set([
      ...outerPreparationNodeIds,
      ...innerBodyPathNodeIds,
      ...continuationNodeIds,
      outerReturnId,
    ]);
    if ([...reachableBodyNodeIds].some((nodeId) => !bodyPathNodeIds.has(nodeId))) {
      return null;
    }
    if (
      [...outerPreparationNodeIds].some(
        (nodeId) =>
          !directInnerForIds.includes(nodeId) && (nodes[nodeId]?.type === 'for' || nodes[nodeId]?.type === 'iterate')
      )
    ) {
      return null;
    }
    for (const bodyNodeId of outerPreparationNodeIds) {
      if (directInnerForIds.includes(bodyNodeId) || innerBodyPathNodeIds.has(bodyNodeId)) {
        continue;
      }
      if (!directInnerForIds.some((innerForId) => hasPath(bodyNodeId, innerForId))) {
        return null;
      }
    }

    return { bodyPathNodeIds, returnId: outerReturnId };
  };

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
          (otherNodeId) => otherNodeId !== nodeId && nodes[otherNodeId]?.type === 'for' && hasPath(otherNodeId, nodeId)
        )
    );
    const nestedBody =
      nestedForNodeIds.length > 0 ? getSupportedNestedForBody(node.id, reachableBodyNodeIds, reachableReturnIds) : null;
    if (nestedForNodeIds.length > 0 && nestedBody === null) {
      return 'nodes.forLoopNestedUnsupported';
    }

    const linkedReturnId = linkedReturnByForId.get(node.id);
    if (nestedBody === null && (linkedReturnId === undefined || !reachableReturnIds.includes(linkedReturnId))) {
      return 'nodes.forLoopReturnCount';
    }

    const returnId = nestedBody?.returnId ?? linkedReturnId;
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
        edges.filter((edge) => edge.destination.node_id === node.id && edge.destination.field === 'state').length > 1 ||
        edges.filter((edge) => edge.destination.node_id === node.id && edge.destination.field === 'continue_condition')
          .length > 1)
    ) {
      return 'nodes.forReturnInputCount';
    }
  }

  return null;
};
