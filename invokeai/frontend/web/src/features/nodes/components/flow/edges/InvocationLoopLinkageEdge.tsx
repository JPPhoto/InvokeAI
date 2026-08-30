import type { SystemStyleObject } from '@invoke-ai/ui-library';
import { chakra } from '@invoke-ai/ui-library';
import type { EdgeProps } from '@xyflow/react';
import { BaseEdge, getBezierPath } from '@xyflow/react';
import { useAppSelector } from 'app/store/storeHooks';
import { buildSelectAreConnectedNodesSelected } from 'features/nodes/components/flow/edges/util/buildEdgeSelectors';
import { selectShouldAnimateEdges } from 'features/nodes/store/workflowSettingsSlice';
import type { LoopLinkageInvocationNodeEdge } from 'features/nodes/types/invocation';
import { memo, useMemo } from 'react';

const ChakraBaseEdge = chakra(BaseEdge);

const edgeSx: SystemStyleObject = {
  strokeWidth: '2px !important',
  stroke: 'green.500 !important',
  strokeDasharray: '6 4',
  opacity: '0.75 !important',
  '&[data-selected="true"]': {
    opacity: '1 !important',
  },
  '&[data-should-animate-edges="true"]': {
    animation: 'dashdraw 0.5s linear infinite !important',
  },
};

const InvocationLoopLinkageEdge = ({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected = false,
  source,
  target,
}: EdgeProps<LoopLinkageInvocationNodeEdge>) => {
  const shouldAnimateEdges = useAppSelector(selectShouldAnimateEdges);
  const selectAreConnectedNodesSelected = useMemo(
    () => buildSelectAreConnectedNodesSelected(source, target),
    [source, target]
  );
  const areConnectedNodesSelected = useAppSelector(selectAreConnectedNodesSelected);
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <ChakraBaseEdge
      path={edgePath}
      markerEnd={markerEnd}
      sx={edgeSx}
      data-selected={selected}
      data-are-connected-nodes-selected={areConnectedNodesSelected}
      data-should-animate-edges={shouldAnimateEdges}
    />
  );
};

export default memo(InvocationLoopLinkageEdge);
