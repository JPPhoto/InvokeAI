import type { WorkflowEdge, WorkflowNode } from '@features/workflow/contracts';

import { Box, Text } from '@chakra-ui/react';
import { getForLoopBodyBoundaries, type LoopBodyBoundaryStatus } from '@features/workflow/utility';
import { useNodes, useReactFlow, ViewportPortal } from '@xyflow/react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { WorkflowFlowEdge, WorkflowFlowNode } from './flowAdapters';

const BOUNDARY_PADDING = 24;

const getStatusColor = (status: LoopBodyBoundaryStatus) =>
  status === 'complete' ? { border: 'green.400', text: 'green.200' } : { border: 'orange.400', text: 'orange.200' };

export const LoopBodyBoundaryOverlay = ({ edges }: { edges: WorkflowEdge[] }) => {
  const { t } = useTranslation();
  const flowNodes = useNodes<WorkflowFlowNode>();
  const { getNodesBounds } = useReactFlow<WorkflowFlowNode, WorkflowFlowEdge>();
  const nodes = useMemo<WorkflowNode[]>(() => flowNodes.map((node) => node.data.documentNode), [flowNodes]);
  const boundaries = useMemo(() => getForLoopBodyBoundaries(nodes, edges), [edges, nodes]);

  return (
    <ViewportPortal>
      {boundaries.map((boundary) => {
        const bounds = getNodesBounds(boundary.bodyNodeIds);

        if (bounds.width <= 0 || bounds.height <= 0) {
          return null;
        }

        const colors = getStatusColor(boundary.status);
        const bodyLabel = t('nodes.forLoopBodyBoundary');
        const statusLabel =
          boundary.status === 'complete' ? '' : t(`nodes.forLoopBodyBoundaryStatus.${boundary.status}`);
        const label = statusLabel ? `${bodyLabel} - ${statusLabel}` : bodyLabel;

        return (
          <Box
            key={`${boundary.forNodeId ?? 'orphan'}-${boundary.returnNodeId ?? 'return'}-${boundary.status}`}
            aria-label={label}
            border="2px dashed"
            borderColor={colors.border}
            borderRadius="base"
            data-loop-body-boundary={boundary.forNodeId ?? boundary.returnNodeId}
            data-loop-body-status={boundary.status}
            h={bounds.height + BOUNDARY_PADDING * 2}
            pointerEvents="none"
            position="absolute"
            transform={`translate(${bounds.x - BOUNDARY_PADDING}px, ${bounds.y - BOUNDARY_PADDING}px)`}
            w={bounds.width + BOUNDARY_PADDING * 2}
            zIndex={0}
          >
            <Text
              position="absolute"
              top={-6}
              left={8}
              px={1}
              bg="bg.canvas"
              color={colors.text}
              fontSize="xs"
              lineHeight="short"
              whiteSpace="nowrap"
            >
              {label}
            </Text>
          </Box>
        );
      })}
    </ViewportPortal>
  );
};

export default memo(LoopBodyBoundaryOverlay);
