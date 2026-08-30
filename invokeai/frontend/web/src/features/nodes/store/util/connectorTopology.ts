import type { PendingConnection, Templates } from 'features/nodes/store/types';
import { LOOP_LINKAGE_FIELD } from 'features/nodes/types/constants';
import type { FieldType } from 'features/nodes/types/field';
import type { AnyEdge, AnyNode } from 'features/nodes/types/invocation';
import { isConnectorNode, isInvocationNode } from 'features/nodes/types/invocation';

export const CONNECTOR_INPUT_HANDLE = 'in';
export const CONNECTOR_OUTPUT_HANDLE = 'out';

type ResolvedConnectorSource = {
  nodeId: string;
  fieldName: string;
};

type ResolvedLoopLinkagePath = {
  forNodeId: string;
  returnNodeId: string;
  edgeIds: string[];
  connectorNodeIds: string[];
};

type SpliceConnection = {
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
};

type SpliceConnectionValidator = (
  connection: SpliceConnection,
  nodes: AnyNode[],
  edges: AnyEdge[],
  templates: Templates,
  ignoreEdge: AnyEdge | null,
  strict?: boolean
) => string | null;

type ResolvedConnectorOutputEdges = {
  edges: AnyEdge[];
  traversedEdgeIds: Set<string>;
};

type ResolvedPendingConnectionSource = {
  nodeId: string;
  fieldName: string;
  outputScope?: 'iteration' | 'final';
};

export const getConnectorInputEdge = (connectorId: string, edges: AnyEdge[]): AnyEdge | undefined =>
  edges.find(
    (edge) =>
      edge.type === 'default' &&
      edge.target === connectorId &&
      edge.targetHandle === CONNECTOR_INPUT_HANDLE &&
      typeof edge.sourceHandle === 'string'
  );

export const getConnectorOutputEdges = (connectorId: string, edges: AnyEdge[]): AnyEdge[] =>
  edges.filter(
    (edge) =>
      edge.type === 'default' &&
      edge.source === connectorId &&
      edge.sourceHandle === CONNECTOR_OUTPUT_HANDLE &&
      typeof edge.targetHandle === 'string'
  );

const getConnectorDeletionOutputEdges = (
  connectorId: string,
  nodes: AnyNode[],
  edges: AnyEdge[],
  removedConnectorIds: ReadonlySet<string>
): ResolvedConnectorOutputEdges | null => {
  const visitedConnectorIds = new Set<string>();
  const traversedEdgeIds = new Set<string>();
  const outputEdges: AnyEdge[] = [];

  const resolve = (currentConnectorId: string): boolean => {
    if (visitedConnectorIds.has(currentConnectorId)) {
      return false;
    }
    visitedConnectorIds.add(currentConnectorId);

    for (const edge of getConnectorOutputEdges(currentConnectorId, edges)) {
      traversedEdgeIds.add(edge.id);
      const targetNode = nodes.find((node) => node.id === edge.target);
      if (removedConnectorIds.has(edge.target) && isConnectorNode(targetNode)) {
        if (!resolve(targetNode.id)) {
          return false;
        }
      } else {
        outputEdges.push(edge);
      }
    }
    return true;
  };

  return resolve(connectorId) ? { edges: outputEdges, traversedEdgeIds } : null;
};

const getConnectorDeletionInputEdgeIds = (
  connectorId: string,
  nodes: AnyNode[],
  edges: AnyEdge[],
  removedConnectorIds: ReadonlySet<string>
): Set<string> => {
  const inputEdgeIds = new Set<string>();
  const visitedConnectorIds = new Set<string>();
  let currentConnectorId: string | null = connectorId;

  while (currentConnectorId && !visitedConnectorIds.has(currentConnectorId)) {
    visitedConnectorIds.add(currentConnectorId);
    const inputEdge = getConnectorInputEdge(currentConnectorId, edges);
    if (!inputEdge) {
      break;
    }
    inputEdgeIds.add(inputEdge.id);

    const sourceNode = nodes.find((node) => node.id === inputEdge.source);
    currentConnectorId = isConnectorNode(sourceNode) && removedConnectorIds.has(sourceNode.id) ? sourceNode.id : null;
  }

  return inputEdgeIds;
};

const resolveSurvivingConnectorDeletionSource = (
  connectorId: string,
  nodes: AnyNode[],
  edges: AnyEdge[],
  removedConnectorIds: ReadonlySet<string>
): ResolvedConnectorSource | null => {
  const visitedConnectorIds = new Set<string>();
  let resolvedSource = resolveConnectorDeletionSource(connectorId, nodes, edges);

  while (resolvedSource && removedConnectorIds.has(resolvedSource.nodeId)) {
    if (visitedConnectorIds.has(resolvedSource.nodeId)) {
      return null;
    }
    visitedConnectorIds.add(resolvedSource.nodeId);
    resolvedSource = resolveConnectorDeletionSource(resolvedSource.nodeId, nodes, edges);
  }

  return resolvedSource;
};

export const resolveConnectorSource = (
  connectorId: string,
  nodes: AnyNode[],
  edges: AnyEdge[]
): ResolvedConnectorSource | null => {
  const visited = new Set<string>();

  const resolve = (nodeId: string): ResolvedConnectorSource | null => {
    if (visited.has(nodeId)) {
      return null;
    }
    visited.add(nodeId);

    const incomingEdge = getConnectorInputEdge(nodeId, edges);
    if (!incomingEdge || incomingEdge.type !== 'default') {
      return null;
    }
    if (typeof incomingEdge.sourceHandle !== 'string') {
      return null;
    }

    const sourceNode = nodes.find((node) => node.id === incomingEdge.source);
    if (!sourceNode) {
      return null;
    }

    if (isInvocationNode(sourceNode)) {
      return { nodeId: sourceNode.id, fieldName: incomingEdge.sourceHandle };
    }

    if (isConnectorNode(sourceNode)) {
      return resolve(sourceNode.id);
    }

    return null;
  };

  return resolve(connectorId);
};

/**
 * Resolves a connector alias used for the visual loop linkage between a For and ForReturn.
 * Every connector on this path must have exactly one input and one output, so the alias cannot
 * branch or be reused as ordinary data flow.
 */
export const resolveLoopLinkagePath = (
  edge: AnyEdge,
  nodes: AnyNode[],
  edges: AnyEdge[]
): ResolvedLoopLinkagePath | null => {
  if (edge.type !== 'default' || edge.targetHandle !== LOOP_LINKAGE_FIELD || typeof edge.sourceHandle !== 'string') {
    return null;
  }

  const returnNode = nodes.find((node) => node.id === edge.target);
  if (!returnNode || !isInvocationNode(returnNode) || returnNode.data.type !== 'for_return') {
    return null;
  }

  const edgeIds = [edge.id];
  const connectorNodeIds: string[] = [];
  const visitedConnectors = new Set<string>();
  let currentEdge: AnyEdge = edge;

  while (true) {
    const sourceNode = nodes.find((node) => node.id === currentEdge.source);
    if (!sourceNode || typeof currentEdge.sourceHandle !== 'string') {
      return null;
    }

    if (isInvocationNode(sourceNode)) {
      if (sourceNode.data.type !== 'for' || currentEdge.sourceHandle !== LOOP_LINKAGE_FIELD) {
        return null;
      }
      return {
        forNodeId: sourceNode.id,
        returnNodeId: returnNode.id,
        edgeIds: [...edgeIds].reverse(),
        connectorNodeIds: [...connectorNodeIds].reverse(),
      };
    }

    if (!isConnectorNode(sourceNode) || currentEdge.sourceHandle !== CONNECTOR_OUTPUT_HANDLE) {
      return null;
    }
    if (visitedConnectors.has(sourceNode.id)) {
      return null;
    }
    visitedConnectors.add(sourceNode.id);
    connectorNodeIds.push(sourceNode.id);

    const inputEdges = edges.filter(
      (candidate) =>
        candidate.type === 'default' &&
        candidate.target === sourceNode.id &&
        candidate.targetHandle === CONNECTOR_INPUT_HANDLE &&
        typeof candidate.sourceHandle === 'string'
    );
    const outputEdges = getConnectorOutputEdges(sourceNode.id, edges);
    if (
      inputEdges.length !== 1 ||
      outputEdges.length !== 1 ||
      (outputEdges[0] !== currentEdge && outputEdges[0]?.id !== currentEdge.id)
    ) {
      return null;
    }

    const inputEdge = inputEdges[0];
    if (!inputEdge) {
      return null;
    }
    edgeIds.push(inputEdge.id);
    currentEdge = inputEdge;
  }
};

const getResolvedLoopLinkagePathForConnector = (
  connectorId: string,
  nodes: AnyNode[],
  edges: AnyEdge[]
): ResolvedLoopLinkagePath | null => {
  for (const edge of edges) {
    if (
      edge.type !== 'default' ||
      edge.sourceHandle !== CONNECTOR_OUTPUT_HANDLE ||
      edge.targetHandle !== LOOP_LINKAGE_FIELD
    ) {
      continue;
    }

    const path = resolveLoopLinkagePath(edge, nodes, edges);
    if (path?.connectorNodeIds.includes(connectorId)) {
      return path;
    }
  }
  return null;
};

/**
 * Finds the serialized connector edges attached to a boundary's loop-linkage alias,
 * including an alias that has not reached its opposite boundary yet.
 */
export const getLoopLinkageAliasEdgeIdsForBoundary = (
  boundaryNodeId: string,
  nodes: AnyNode[],
  edges: AnyEdge[]
): Set<string> => {
  const edgeIds = new Set<string>();
  const visitedForwardConnectorIds = new Set<string>();
  const visitedBackwardConnectorIds = new Set<string>();

  const visitForward = (connectorId: string): void => {
    if (visitedForwardConnectorIds.has(connectorId)) {
      return;
    }
    visitedForwardConnectorIds.add(connectorId);
    for (const edge of getConnectorOutputEdges(connectorId, edges)) {
      edgeIds.add(edge.id);
      const targetNode = nodes.find((node) => node.id === edge.target);
      if (isConnectorNode(targetNode) && edge.targetHandle === CONNECTOR_INPUT_HANDLE) {
        visitForward(targetNode.id);
      }
    }
  };

  const visitBackward = (connectorId: string): void => {
    if (visitedBackwardConnectorIds.has(connectorId)) {
      return;
    }
    visitedBackwardConnectorIds.add(connectorId);
    const inputEdge = getConnectorInputEdge(connectorId, edges);
    if (!inputEdge) {
      return;
    }
    edgeIds.add(inputEdge.id);
    const sourceNode = nodes.find((node) => node.id === inputEdge.source);
    if (isConnectorNode(sourceNode) && inputEdge.sourceHandle === CONNECTOR_OUTPUT_HANDLE) {
      visitBackward(sourceNode.id);
    }
  };

  for (const edge of edges) {
    if (edge.type !== 'default') {
      continue;
    }

    if (
      edge.source === boundaryNodeId &&
      edge.sourceHandle === LOOP_LINKAGE_FIELD &&
      edge.targetHandle === CONNECTOR_INPUT_HANDLE
    ) {
      const targetNode = nodes.find((node) => node.id === edge.target);
      if (isConnectorNode(targetNode)) {
        edgeIds.add(edge.id);
        visitForward(targetNode.id);
      }
    }

    if (
      edge.target === boundaryNodeId &&
      edge.targetHandle === LOOP_LINKAGE_FIELD &&
      edge.sourceHandle === CONNECTOR_OUTPUT_HANDLE
    ) {
      const sourceNode = nodes.find((node) => node.id === edge.source);
      if (isConnectorNode(sourceNode)) {
        edgeIds.add(edge.id);
        visitBackward(sourceNode.id);
      }
    }
  }

  return edgeIds;
};

/**
 * Builds the edge list used only for React Flow rendering. Complete connector
 * aliases are presented as loop-linkage edges so they use the dashed green
 * renderer; the supplied edge list is never mutated.
 */
export const getEdgesWithLoopLinkageAliases = (nodes: AnyNode[], edges: AnyEdge[]): AnyEdge[] => {
  const loopLinkageEdgeIds = new Set<string>();
  for (const edge of edges) {
    if (
      edge.type !== 'default' ||
      edge.sourceHandle !== CONNECTOR_OUTPUT_HANDLE ||
      edge.targetHandle !== LOOP_LINKAGE_FIELD ||
      !isConnectorNode(nodes.find((node) => node.id === edge.source))
    ) {
      continue;
    }

    const path = resolveLoopLinkagePath(edge, nodes, edges);
    path?.edgeIds.forEach((edgeId) => loopLinkageEdgeIds.add(edgeId));
  }

  return edges.map((edge) => (loopLinkageEdgeIds.has(edge.id) ? ({ ...edge, type: 'loop_linkage' } as AnyEdge) : edge));
};

/**
 * Resolves the source to use when removing a connector. Loop-linkage aliases
 * preserve the remaining connector chain; ordinary data connectors keep
 * splicing back to their invocation source.
 */
const resolveConnectorDeletionSource = (
  connectorId: string,
  nodes: AnyNode[],
  edges: AnyEdge[]
): ResolvedConnectorSource | null => {
  const resolvedSource = resolveConnectorSource(connectorId, nodes, edges);
  if (!resolvedSource) {
    return null;
  }

  const sourceNode = nodes.find((node) => node.id === resolvedSource.nodeId);
  if (
    isInvocationNode(sourceNode) &&
    sourceNode.data.type === 'for' &&
    resolvedSource.fieldName === LOOP_LINKAGE_FIELD
  ) {
    const outputEdges = getConnectorOutputEdges(connectorId, edges);
    if (
      outputEdges.length !== 1 ||
      outputEdges.some((edge) => {
        const targetNode = nodes.find((node) => node.id === edge.target);
        return !(
          (isConnectorNode(targetNode) && edge.targetHandle === CONNECTOR_INPUT_HANDLE) ||
          (isInvocationNode(targetNode) &&
            targetNode.data.type === 'for_return' &&
            edge.targetHandle === LOOP_LINKAGE_FIELD)
        );
      })
    ) {
      return null;
    }
  }

  const linkagePath = getResolvedLoopLinkagePathForConnector(connectorId, nodes, edges);
  const inputEdge = getConnectorInputEdge(connectorId, edges);
  if (linkagePath && inputEdge && typeof inputEdge.sourceHandle === 'string') {
    return {
      nodeId: inputEdge.source,
      fieldName: inputEdge.sourceHandle,
    };
  }

  return resolvedSource;
};

export const resolvePendingConnectionSource = (
  pendingConnection: PendingConnection | null,
  nodes: AnyNode[],
  edges: AnyEdge[],
  templates?: Templates
): ResolvedPendingConnectionSource | null => {
  if (!pendingConnection || pendingConnection.handleType !== 'source') {
    return null;
  }

  const pendingNode = nodes.find((node) => node.id === pendingConnection.nodeId);
  const resolvedSource =
    pendingNode && isConnectorNode(pendingNode)
      ? resolveConnectorSource(pendingNode.id, nodes, edges)
      : isInvocationNode(pendingNode)
        ? { nodeId: pendingNode.id, fieldName: pendingConnection.handleId }
        : null;
  if (!resolvedSource) {
    return null;
  }

  const sourceNode = nodes.find((node) => node.id === resolvedSource.nodeId);
  const outputScope =
    sourceNode && isInvocationNode(sourceNode)
      ? (templates?.[sourceNode.data.type]?.outputs[resolvedSource.fieldName]?.output_scope ?? undefined)
      : undefined;

  return { ...resolvedSource, outputScope };
};

export const resolveConnectorSourceFieldType = (
  connectorId: string,
  nodes: AnyNode[],
  edges: AnyEdge[],
  templates: Templates
): FieldType | null => {
  const resolvedSource = resolveConnectorSource(connectorId, nodes, edges);
  if (!resolvedSource) {
    return null;
  }

  const sourceNode = nodes.find((node) => node.id === resolvedSource.nodeId);
  if (!sourceNode || !isInvocationNode(sourceNode)) {
    return null;
  }

  const sourceTemplate = templates[sourceNode.data.type];
  return sourceTemplate?.outputs[resolvedSource.fieldName]?.type ?? null;
};

export const getConnectorDeletionSpliceConnections = (
  connectorId: string,
  nodes: AnyNode[],
  edges: AnyEdge[],
  templates?: Templates,
  validateConnection?: SpliceConnectionValidator,
  removedConnectorIds: ReadonlySet<string> = new Set()
): SpliceConnection[] | null => {
  const resolvedSource = resolveSurvivingConnectorDeletionSource(connectorId, nodes, edges, removedConnectorIds);
  if (!resolvedSource) {
    return null;
  }

  const resolvedOutputEdges = getConnectorDeletionOutputEdges(connectorId, nodes, edges, removedConnectorIds);
  if (!resolvedOutputEdges) {
    return null;
  }
  const { edges: outputEdges, traversedEdgeIds } = resolvedOutputEdges;
  const inputEdgeIds = getConnectorDeletionInputEdgeIds(connectorId, nodes, edges, removedConnectorIds);
  const spliceConnections = outputEdges
    .filter((edge): edge is AnyEdge & { type: 'default'; targetHandle: string } => edge.type === 'default')
    .map((edge) => ({
      source: resolvedSource.nodeId,
      sourceHandle: resolvedSource.fieldName,
      target: edge.target,
      targetHandle: edge.targetHandle,
    }));

  const deduped = new Set<string>();
  for (const connection of spliceConnections) {
    const key = `${connection.source}:${connection.sourceHandle}->${connection.target}:${connection.targetHandle}`;
    if (deduped.has(key)) {
      return null;
    }
    deduped.add(key);
  }

  if (!templates) {
    return validateConnection ? null : spliceConnections;
  }

  if (!validateConnection) {
    const sourceType = resolveConnectorSourceFieldType(connectorId, nodes, edges, templates);
    if (!sourceType) {
      return null;
    }
    const outputEdgeIds = traversedEdgeIds;

    for (const connection of spliceConnections) {
      const targetNode = nodes.find((node) => node.id === connection.target);
      if (!targetNode || !isInvocationNode(targetNode)) {
        return null;
      }
      const targetTemplate = templates[targetNode.data.type];
      const targetFieldTemplate = targetTemplate?.inputs[connection.targetHandle];
      if (!targetFieldTemplate) {
        return null;
      }

      const matchesExistingDirectEdge = edges.some(
        (edge) =>
          edge.type === 'default' &&
          edge.source === connection.source &&
          edge.sourceHandle === connection.sourceHandle &&
          edge.target === connection.target &&
          edge.targetHandle === connection.targetHandle
      );
      if (matchesExistingDirectEdge) {
        return null;
      }

      const targetConflictCount = spliceConnections.filter(
        (candidate) => candidate.target === connection.target && candidate.targetHandle === connection.targetHandle
      ).length;
      const existingTargetConflict = edges.some(
        (edge) =>
          edge.type === 'default' &&
          !inputEdgeIds.has(edge.id) &&
          !outputEdgeIds.has(edge.id) &&
          edge.target === connection.target &&
          edge.targetHandle === connection.targetHandle
      );
      if (
        targetFieldTemplate.type.name !== 'CollectionItemField' &&
        (targetConflictCount > 1 || existingTargetConflict)
      ) {
        return null;
      }

      if (
        sourceType.name !== targetFieldTemplate.type.name &&
        targetFieldTemplate.type.name !== 'CollectionItemField'
      ) {
        return null;
      }
    }

    return spliceConnections;
  }

  const ignoredEdgeIds = new Set([...inputEdgeIds, ...traversedEdgeIds]);
  const existingEdges = edges.filter((edge) => !ignoredEdgeIds.has(edge.id));
  const stagedConnections: SpliceConnection[] = [];

  for (const connection of spliceConnections) {
    const stagedEdges = [
      ...existingEdges,
      ...stagedConnections.map(
        ({ source, sourceHandle, target, targetHandle }) =>
          ({
            id: `splice-${source}-${sourceHandle}-${target}-${targetHandle}`,
            type: 'default',
            source,
            sourceHandle,
            target,
            targetHandle,
          }) satisfies AnyEdge
      ),
    ];
    if (validateConnection(connection, nodes, stagedEdges, templates, null, true) !== null) {
      return null;
    }
    stagedConnections.push(connection);
  }

  return spliceConnections;
};
