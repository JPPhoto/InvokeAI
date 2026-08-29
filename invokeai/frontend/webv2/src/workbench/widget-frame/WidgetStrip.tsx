import type { WidgetRegion } from '@workbench/layoutContracts';
import type { WidgetInstanceId } from '@workbench/widgetContracts';
import type { WidgetDndSurface, WidgetRegionDropState } from '@workbench/widgetDnd';

import { Flex, type FlexProps } from '@chakra-ui/react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, type SortingStrategy } from '@dnd-kit/sortable';
import { getWidgetInstanceDragId, getWidgetRegionDropData, getWidgetRegionDropId } from '@workbench/widgetDnd';
import { useMemo, type ReactNode } from 'react';

import { WidgetRegionDropOverlay } from './WidgetRegionDropOverlay';

interface WidgetStripProps extends FlexProps {
  children: ReactNode;
  dropState: WidgetRegionDropState;
  region: WidgetRegion;
  sortableInstanceIds: WidgetInstanceId[];
  strategy: SortingStrategy;
  surface?: WidgetDndSurface;
}

export const WidgetStrip = ({
  children,
  dropState,
  region,
  sortableInstanceIds,
  strategy,
  surface = 'rail',
  ...props
}: WidgetStripProps) => {
  const { isOver, setNodeRef } = useDroppable({
    data: getWidgetRegionDropData(region),
    disabled: !dropState.isActive || !dropState.isAllowed,
    id: getWidgetRegionDropId(region, surface),
  });
  const sortableItems = useMemo(
    () => sortableInstanceIds.map((id) => getWidgetInstanceDragId(region, id, surface)),
    [region, sortableInstanceIds, surface]
  );

  return (
    <Flex ref={setNodeRef} position="relative" {...props}>
      <SortableContext items={sortableItems} strategy={strategy}>
        {children}
      </SortableContext>
      {dropState.isActive ? <WidgetRegionDropOverlay dropState={dropState} isOver={isOver} /> : null}
    </Flex>
  );
};
