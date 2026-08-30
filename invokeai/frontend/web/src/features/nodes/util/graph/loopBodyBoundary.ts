import { CONNECTOR_OUTPUT_HANDLE, resolveLoopLinkagePath } from 'features/nodes/store/util/connectorTopology';
import { isLoopLinkageEdge } from 'features/nodes/store/util/reactFlowUtil';
import { LOOP_LINKAGE_FIELD } from 'features/nodes/types/constants';
import type { AnyEdge, AnyNode } from 'features/nodes/types/invocation';
import { isConnectorNode, isInvocationNode } from 'features/nodes/types/invocation';

const ITERATION_OUTPUT_FIELDS = new Set(['item', 'index', 'total', 'state']);

export type LoopBodyBoundaryStatus =
  | 'complete'
  | 'missing_linkage'
  | 'invalid_linkage'
  | 'duplicate_linkage'
  | 'missing_return'
  | 'multiple_returns'
  | 'orphan_return';

type LoopBodyBoundary = {
  forNodeId?: string;
  returnNodeId?: string;
  bodyNodeIds: string[];
  status: LoopBodyBoundaryStatus;
};

const getReachableNodeIds = (startIds: string[], outgoing: Map<string, string[]>): Set<string> => {
  const visited = new Set<string>();
  const pending = [...startIds];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (nodeId === undefined || visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);
    pending.push(...(outgoing.get(nodeId) ?? []));
  }
  return visited;
};

const getBoundaryNodeIds = (
  nodes: AnyNode[],
  reachableNodeIds: Set<string>,
  returnNodeId: string | undefined,
  incoming: Map<string, string[]>,
  additionalNodeIds: Set<string> = new Set()
): string[] => {
  const bodyNodeIds = returnNodeId
    ? new Set([...getReachableNodeIds([returnNodeId], incoming)].filter((nodeId) => reachableNodeIds.has(nodeId)))
    : new Set(reachableNodeIds);
  if (returnNodeId) {
    bodyNodeIds.add(returnNodeId);
  }
  additionalNodeIds.forEach((nodeId) => bodyNodeIds.add(nodeId));
  return nodes.filter((node) => bodyNodeIds.has(node.id)).map((node) => node.id);
};

export const getForLoopBodyBoundaries = (nodes: AnyNode[], edges: AnyEdge[]): LoopBodyBoundary[] => {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const resolvedConnectorLinkages = edges.flatMap((edge) => {
    if (
      edge.type !== 'default' ||
      edge.sourceHandle !== CONNECTOR_OUTPUT_HANDLE ||
      edge.targetHandle !== LOOP_LINKAGE_FIELD ||
      !isConnectorNode(nodes.find((node) => node.id === edge.source))
    ) {
      return [];
    }
    const path = resolveLoopLinkagePath(edge, nodes, edges);
    return path ? [path] : [];
  });
  const resolvedConnectorLinkageEdgeIds = new Set(resolvedConnectorLinkages.flatMap((path) => path.edgeIds));
  const resolvedConnectorNodeIdsByForId = new Map<string, string[]>();
  for (const path of resolvedConnectorLinkages) {
    resolvedConnectorNodeIdsByForId.set(path.forNodeId, [
      ...(resolvedConnectorNodeIdsByForId.get(path.forNodeId) ?? []),
      ...path.connectorNodeIds,
    ]);
  }
  const executableEdges = edges.filter(
    (edge) => !isLoopLinkageEdge(edge) && !resolvedConnectorLinkageEdgeIds.has(edge.id)
  );
  const linkageEdges = [
    ...edges.filter(isLoopLinkageEdge),
    ...resolvedConnectorLinkages.map(
      ({ forNodeId, returnNodeId }) =>
        ({
          id: `resolved-loop-linkage-${forNodeId}-${returnNodeId}`,
          type: 'loop_linkage' as const,
          source: forNodeId,
          sourceHandle: LOOP_LINKAGE_FIELD,
          target: returnNodeId,
          targetHandle: LOOP_LINKAGE_FIELD,
        }) satisfies AnyEdge
    ),
  ];
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();

  for (const edge of executableEdges) {
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) {
      continue;
    }
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
  }

  const linkedReturnByForId = new Map<string, string>();
  const linkedForByReturnId = new Map<string, string>();
  const duplicateForIds = new Set<string>();
  const duplicateReturnIds = new Set<string>();
  const invalidForIds = new Set<string>();
  const invalidReturnIds = new Set<string>();

  for (const edge of linkageEdges) {
    const sourceNode = nodesById.get(edge.source);
    const targetNode = nodesById.get(edge.target);
    if (
      edge.sourceHandle !== LOOP_LINKAGE_FIELD ||
      edge.targetHandle !== LOOP_LINKAGE_FIELD ||
      !isInvocationNode(sourceNode) ||
      sourceNode.data.type !== 'for' ||
      !isInvocationNode(targetNode) ||
      targetNode.data.type !== 'for_return'
    ) {
      if (sourceNode?.type === 'invocation' && sourceNode.data.type === 'for') {
        invalidForIds.add(sourceNode.id);
      }
      if (targetNode?.type === 'invocation' && targetNode.data.type === 'for_return') {
        invalidReturnIds.add(targetNode.id);
      }
      continue;
    }
    if (linkedReturnByForId.has(sourceNode.id)) {
      duplicateForIds.add(sourceNode.id);
    } else {
      linkedReturnByForId.set(sourceNode.id, targetNode.id);
    }
    if (linkedForByReturnId.has(targetNode.id)) {
      duplicateReturnIds.add(targetNode.id);
    } else {
      linkedForByReturnId.set(targetNode.id, sourceNode.id);
    }
  }

  const reachableReturnIds = new Set<string>();
  const forBoundaries = nodes
    .filter((node) => isInvocationNode(node) && node.data.type === 'for')
    .map((forNode) => {
      const iterationTargets = executableEdges
        .filter(
          (edge) =>
            edge.source === forNode.id &&
            typeof edge.sourceHandle === 'string' &&
            ITERATION_OUTPUT_FIELDS.has(edge.sourceHandle)
        )
        .map((edge) => edge.target);
      const reachableNodeIds = getReachableNodeIds(iterationTargets, outgoing);
      const reachableReturnNodes = nodes.filter(
        (node) => reachableNodeIds.has(node.id) && isInvocationNode(node) && node.data.type === 'for_return'
      );
      reachableReturnNodes.forEach((node) => reachableReturnIds.add(node.id));

      const linkedReturnId = linkedReturnByForId.get(forNode.id);
      const returnNodeId =
        linkedReturnId ?? (reachableReturnNodes.length === 1 ? reachableReturnNodes[0]?.id : undefined);
      let status: LoopBodyBoundaryStatus;
      if (duplicateForIds.has(forNode.id) || (linkedReturnId !== undefined && duplicateReturnIds.has(linkedReturnId))) {
        status = 'duplicate_linkage';
      } else if (invalidForIds.has(forNode.id)) {
        status = 'invalid_linkage';
      } else if (linkedReturnId === undefined) {
        status = 'missing_linkage';
      } else if (!reachableNodeIds.has(linkedReturnId)) {
        status = 'invalid_linkage';
      } else if (reachableReturnNodes.length === 0) {
        status = 'missing_return';
      } else if (reachableReturnNodes.length > 1) {
        status = 'multiple_returns';
      } else {
        status = 'complete';
      }

      return {
        forNodeId: forNode.id,
        ...(returnNodeId ? { returnNodeId } : {}),
        bodyNodeIds: [
          forNode.id,
          ...getBoundaryNodeIds(
            nodes,
            reachableNodeIds,
            returnNodeId,
            incoming,
            new Set(resolvedConnectorNodeIdsByForId.get(forNode.id))
          ).filter((id) => id !== forNode.id),
        ],
        status,
      };
    });

  const orphanReturnBoundaries = nodes
    .filter(
      (node) =>
        isInvocationNode(node) &&
        node.data.type === 'for_return' &&
        !linkedForByReturnId.has(node.id) &&
        (!reachableReturnIds.has(node.id) || invalidReturnIds.has(node.id))
    )
    .map((returnNode) => ({
      forNodeId: linkedForByReturnId.get(returnNode.id),
      returnNodeId: returnNode.id,
      bodyNodeIds: [returnNode.id],
      status: duplicateReturnIds.has(returnNode.id)
        ? ('duplicate_linkage' as const)
        : invalidReturnIds.has(returnNode.id)
          ? ('invalid_linkage' as const)
          : ('orphan_return' as const),
    }));

  return [...forBoundaries, ...orphanReturnBoundaries];
};
