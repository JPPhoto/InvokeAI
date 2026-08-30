import { Box, Text } from '@invoke-ai/ui-library';
import { useNodes, useReactFlow, ViewportPortal } from '@xyflow/react';
import type { AnyEdge, AnyNode } from 'features/nodes/types/invocation';
import { getForLoopBodyBoundaries, type LoopBodyBoundaryStatus } from 'features/nodes/util/graph/loopBodyBoundary';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

const BOUNDARY_PADDING = 24;

const getStatusColor = (status: LoopBodyBoundaryStatus) => {
  if (status === 'complete') {
    return {
      border: 'var(--invoke-colors-teal-400)',
      text: 'var(--invoke-colors-teal-200)',
    };
  }
  return {
    border: 'var(--invoke-colors-orange-400)',
    text: 'var(--invoke-colors-orange-200)',
  };
};

type Props = {
  edges: AnyEdge[];
};

const LoopBodyBoundaryOverlay = ({ edges }: Props) => {
  const { t } = useTranslation();
  const nodes = useNodes<AnyNode>();
  const { getNodesBounds } = useReactFlow<AnyNode, AnyEdge>();

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
            position="absolute"
            pointerEvents="none"
            transform={`translate(${bounds.x - BOUNDARY_PADDING}px, ${bounds.y - BOUNDARY_PADDING}px)`}
            width={bounds.width + BOUNDARY_PADDING * 2}
            height={bounds.height + BOUNDARY_PADDING * 2}
            border="2px dashed"
            borderColor={colors.border}
            borderRadius="base"
            data-loop-body-boundary={boundary.forNodeId ?? boundary.returnNodeId}
            data-loop-body-status={boundary.status}
            aria-label={label}
            zIndex={0}
          >
            <Text
              position="absolute"
              top={-6}
              left={8}
              px={1}
              bg="base.900"
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
