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

    if ([...bodyPathNodeIds].some((nodeId) => nodes[nodeId]?.type === 'iterate')) {
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
