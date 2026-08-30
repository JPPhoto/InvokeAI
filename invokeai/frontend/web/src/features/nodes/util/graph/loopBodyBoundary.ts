import { createLoopBodyIdentity, getLoopBodyIdentity } from 'features/nodes/store/util/loopIdentity';
import type { AnyEdge, AnyNode, InvocationNode } from 'features/nodes/types/invocation';
import { isInvocationNode } from 'features/nodes/types/invocation';

const ITERATION_OUTPUT_FIELDS = new Set(['item', 'index', 'total', 'state']);

export type LoopBodyBoundaryStatus =
  | 'complete'
  | 'missing_return'
  | 'multiple_returns'
  | 'identity_empty'
  | 'identity_missing'
  | 'identity_mismatch'
  | 'stale_identity'
  | 'duplicate_identity'
  | 'orphan_return';

type LoopBodyBoundary = {
  forNodeId?: string;
  returnNodeId?: string;
  bodyNodeIds: string[];
  bodyId?: string;
  status: LoopBodyBoundaryStatus;
};

const isLoopBoundary = (node: AnyNode): node is InvocationNode =>
  isInvocationNode(node) && (node.data.type === 'for' || node.data.type === 'for_return');

const getRawBodyId = (node: AnyNode): unknown => {
  if (!isLoopBoundary(node)) {
    return undefined;
  }
  return node.data.inputs.body_id?.value;
};

const getBodyIds = (nodes: AnyNode[]) => {
  const counts = new Map<string, { forCount: number; returnCount: number }>();
  for (const node of nodes) {
    const bodyId = getLoopBodyIdentity(node);
    if (!bodyId || !isInvocationNode(node)) {
      continue;
    }
    const count = counts.get(bodyId) ?? { forCount: 0, returnCount: 0 };
    if (node.data.type === 'for') {
      count.forCount += 1;
    } else if (node.data.type === 'for_return') {
      count.returnCount += 1;
    }
    counts.set(bodyId, count);
  }
  return counts;
};

const hasDuplicateBodyId = (
  bodyId: string | undefined,
  nodeType: 'for' | 'for_return',
  bodyIdCounts: Map<string, { forCount: number; returnCount: number }>
): boolean => {
  if (!bodyId) {
    return false;
  }
  const count = bodyIdCounts.get(bodyId);
  return nodeType === 'for' ? (count?.forCount ?? 0) > 1 : (count?.returnCount ?? 0) > 1;
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
  incoming: Map<string, string[]>
): string[] => {
  const bodyNodeIds = returnNodeId
    ? new Set([...getReachableNodeIds([returnNodeId], incoming)].filter((nodeId) => reachableNodeIds.has(nodeId)))
    : new Set(reachableNodeIds);
  if (returnNodeId) {
    bodyNodeIds.add(returnNodeId);
  }
  return nodes.filter((node) => bodyNodeIds.has(node.id)).map((node) => node.id);
};

export const getForLoopBodyBoundaries = (nodes: AnyNode[], edges: AnyEdge[]): LoopBodyBoundary[] => {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const executableEdges = edges.filter((edge) => edge.type === 'default');

  for (const edge of executableEdges) {
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) {
      continue;
    }
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
  }

  const bodyIdCounts = getBodyIds(nodes);

  const reachableReturnIds = new Set<string>();
  const forBoundaries = nodes
    .filter((node) => isInvocationNode(node) && node.data.type === 'for')
    .map((forNode) => {
      const rawBodyId = getRawBodyId(forNode);
      const bodyId = getLoopBodyIdentity(forNode);
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
      const matchingReturnNodes = bodyId
        ? reachableReturnNodes.filter((node) => getLoopBodyIdentity(node) === bodyId)
        : [];
      const duplicateIdentity =
        hasDuplicateBodyId(bodyId, 'for', bodyIdCounts) ||
        reachableReturnNodes.some((node) => hasDuplicateBodyId(getLoopBodyIdentity(node), 'for_return', bodyIdCounts));
      const returnNodeId =
        matchingReturnNodes[0]?.id ?? (reachableReturnNodes.length === 1 ? reachableReturnNodes[0]?.id : undefined);

      let status: LoopBodyBoundaryStatus;
      if (rawBodyId === '') {
        status = 'identity_empty';
      } else if (duplicateIdentity) {
        status = 'duplicate_identity';
      } else if (bodyId) {
        if (matchingReturnNodes.length === 1) {
          status = 'complete';
        } else if (reachableReturnNodes.length === 0) {
          const hasDetachedMatchingReturn = nodes.some(
            (node) => isInvocationNode(node) && node.data.type === 'for_return' && getLoopBodyIdentity(node) === bodyId
          );
          status = hasDetachedMatchingReturn ? 'stale_identity' : 'missing_return';
        } else if (reachableReturnNodes.length === 1 && getLoopBodyIdentity(reachableReturnNodes[0]) === undefined) {
          status = 'identity_missing';
        } else if (reachableReturnNodes.length === 1) {
          status = 'identity_mismatch';
        } else {
          status = 'multiple_returns';
        }
      } else if (reachableReturnNodes.length === 1) {
        status = getLoopBodyIdentity(reachableReturnNodes[0]) === undefined ? 'complete' : 'identity_missing';
      } else if (reachableReturnNodes.length > 1) {
        status = 'multiple_returns';
      } else {
        status = 'missing_return';
      }

      return {
        forNodeId: forNode.id,
        ...(returnNodeId ? { returnNodeId } : {}),
        bodyNodeIds: [
          forNode.id,
          ...getBoundaryNodeIds(nodes, reachableNodeIds, returnNodeId, incoming).filter((id) => id !== forNode.id),
        ],
        ...(bodyId ? { bodyId } : {}),
        status,
      };
    });

  const orphanReturnBoundaries = nodes
    .filter((node) => isInvocationNode(node) && node.data.type === 'for_return' && !reachableReturnIds.has(node.id))
    .map((returnNode) => {
      const bodyId = getLoopBodyIdentity(returnNode);
      const status: LoopBodyBoundaryStatus = !bodyId
        ? 'orphan_return'
        : hasDuplicateBodyId(bodyId, 'for_return', bodyIdCounts)
          ? 'duplicate_identity'
          : 'stale_identity';
      return {
        forNodeId: undefined,
        returnNodeId: returnNode.id,
        bodyNodeIds: [returnNode.id],
        ...(bodyId ? { bodyId } : {}),
        status,
      };
    });

  return [...forBoundaries, ...orphanReturnBoundaries];
};

const hasInvalidBodyIdentity = (node: AnyNode): boolean => {
  if (!isLoopBoundary(node)) {
    return false;
  }
  const bodyId = node.data.inputs.body_id?.value;
  return bodyId !== undefined && bodyId !== null && typeof bodyId !== 'string';
};

const setBodyIdentity = (node: AnyNode, bodyId: string): void => {
  if (isLoopBoundary(node) && node.data.inputs.body_id) {
    node.data.inputs.body_id.value = bodyId;
  }
};

/** Assigns durable identities after an unambiguous loop boundary is completed in the editor. */
export const reconcileForLoopBodyIdentities = (
  nodes: AnyNode[],
  edges: AnyEdge[],
  createBodyId: () => string = createLoopBodyIdentity
): void => {
  const boundaries = getForLoopBodyBoundaries(nodes, edges).filter(
    (boundary) =>
      (boundary.status === 'complete' || boundary.status === 'identity_missing') &&
      boundary.forNodeId !== undefined &&
      boundary.returnNodeId !== undefined
  );
  const bodyIdCounts = getBodyIds(nodes);
  const returnBoundaryCounts = new Map<string, number>();
  for (const boundary of boundaries) {
    if (boundary.returnNodeId !== undefined) {
      returnBoundaryCounts.set(boundary.returnNodeId, (returnBoundaryCounts.get(boundary.returnNodeId) ?? 0) + 1);
    }
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  for (const boundary of boundaries) {
    if (
      boundary.forNodeId === undefined ||
      boundary.returnNodeId === undefined ||
      returnBoundaryCounts.get(boundary.returnNodeId) !== 1
    ) {
      continue;
    }

    const forNode = nodesById.get(boundary.forNodeId);
    const returnNode = nodesById.get(boundary.returnNodeId);
    if (!forNode || !returnNode || hasInvalidBodyIdentity(forNode) || hasInvalidBodyIdentity(returnNode)) {
      continue;
    }

    const forBodyId = getLoopBodyIdentity(forNode);
    const returnBodyId = getLoopBodyIdentity(returnNode);
    if (forBodyId === undefined && returnBodyId !== undefined) {
      // A return-only identity may be stale. Do not silently adopt it.
      continue;
    }
    if (forBodyId !== undefined && returnBodyId === undefined && (bodyIdCounts.get(forBodyId)?.returnCount ?? 0) > 0) {
      // A detached return may still claim this identity. Do not create duplicate ownership.
      continue;
    }
    if (forBodyId !== undefined && returnBodyId !== undefined) {
      continue;
    }

    const bodyId = forBodyId ?? createBodyId();
    setBodyIdentity(forNode, bodyId);
    setBodyIdentity(returnNode, bodyId);
  }
};
