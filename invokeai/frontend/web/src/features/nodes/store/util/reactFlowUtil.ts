import type { Connection } from '@xyflow/react';
import { LOOP_LINKAGE_FIELD } from 'features/nodes/types/constants';
import type { AnyEdge } from 'features/nodes/types/invocation';
import { assert } from 'tsafe';

export const getEdgeTypeFromHandles = (
  sourceHandle: string | null | undefined,
  targetHandle: string | null | undefined
): 'default' | 'loop_linkage' =>
  sourceHandle === LOOP_LINKAGE_FIELD && targetHandle === LOOP_LINKAGE_FIELD ? 'loop_linkage' : 'default';

export const isLoopLinkageEdge = (edge: Pick<AnyEdge, 'type' | 'sourceHandle' | 'targetHandle'>): boolean =>
  edge.type === 'loop_linkage' ||
  (edge.type === 'default' && getEdgeTypeFromHandles(edge.sourceHandle, edge.targetHandle) === 'loop_linkage');

/**
 * Gets the edge id for a connection
 * Copied from: https://github.com/xyflow/xyflow/blob/v11/packages/core/src/utils/graph.ts#L44-L45
 * Requested for this to be exported in: https://github.com/xyflow/xyflow/issues/4290
 * @param connection The connection to get the id for
 * @returns The edge id
 */
const getEdgeId = (connection: Connection): string => {
  const { source, sourceHandle, target, targetHandle } = connection;
  return `reactflow__edge-${source}${sourceHandle || ''}-${target}${targetHandle || ''}`;
};

/**
 * Converts a connection to an edge
 * @param connection The connection to convert to an edge
 * @returns The edge
 * @throws If the connection is invalid (e.g. missing source, sourcehandle, target, or targetHandle)
 */
export const connectionToEdge = (connection: Connection): AnyEdge => {
  const { source, sourceHandle, target, targetHandle } = connection;
  assert(source && sourceHandle && target && targetHandle, 'Invalid connection');
  return {
    type: getEdgeTypeFromHandles(sourceHandle, targetHandle),
    source,
    sourceHandle,
    target,
    targetHandle,
    id: getEdgeId({ source, sourceHandle, target, targetHandle }),
  };
};
