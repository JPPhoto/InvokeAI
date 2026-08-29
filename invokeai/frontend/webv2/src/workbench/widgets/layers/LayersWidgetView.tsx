import type { LayerStackKind } from '@workbench/canvas-engine/api';

import { Flex, Icon, Stack, Text } from '@chakra-ui/react';
import { LAYER_STACKS_TOP_FIRST } from '@workbench/canvas-engine/api';
import {
  publishLayerPanelSelection,
  selectLayerInPanel,
  setLayerGroupExpanded,
  toggleLayerStackCollapsed,
  useLayerPanelState,
  type LayerSelectionModifiers,
} from '@workbench/layerPanelState';
import { useCanvasProjectMutationDispatch } from '@workbench/useCanvasProjectMutationDispatch';
import { useCanvasDocumentEditingLocked } from '@workbench/widgets/canvas/engineStoreHooks';
import { useCanvasEngine } from '@workbench/widgets/canvas/useCanvasEngine';
import { useActiveProjectId, useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { LayersIcon } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { LayerMultiSelectionActions } from './LayerMultiSelectionActions';
import { isLayerPropertiesRequestedWithin, useCurrentLayerPropertiesRequest } from './layerPropertiesRequestStore';
import { LayersPanelHeader } from './LayersPanelHeader';
import { LayerStackSection } from './LayerStackSection';
import { buildLayerStackRows } from './layerTreeRows';

/**
 * The layers panel: a fixed Photoshop-style header region (selected layer's opacity + blend mode,
 * global denoising strength) above the four stacks (inpaint masks / regional guidance / control /
 * raster), each a tree of groups and layers rendered top first.
 */
export const LayersWidgetView = () => {
  const { t } = useTranslation();
  const engine = useCanvasEngine();
  const projectId = useActiveProjectId();
  const dispatch = useCanvasProjectMutationDispatch();
  const editingLocked = useCanvasDocumentEditingLocked(engine);
  const propertiesRequest = useCurrentLayerPropertiesRequest();
  const document = useActiveProjectSelector((project) => project.canvas.document);
  const { selectedLayerId } = document;

  const panelState = useLayerPanelState(projectId, selectedLayerId);
  const expandedGroupIds = useMemo(() => new Set(panelState.expandedGroupIds), [panelState.expandedGroupIds]);
  const stacks = useMemo(() => buildLayerStackRows(document, expandedGroupIds), [document, expandedGroupIds]);
  const visibleStacks = useMemo(
    () => LAYER_STACKS_TOP_FIRST.map((kind) => stacks[kind]).filter((stack) => stack.nodeIds.length > 0),
    [stacks]
  );
  const { collapsedStacks, selectedIds } = panelState;
  const isCollapsed = useCallback(
    (stack: LayerStackKind): boolean =>
      collapsedStacks.includes(stack) && !isLayerPropertiesRequestedWithin(propertiesRequest, stacks[stack].nodeIds),
    [collapsedStacks, propertiesRequest, stacks]
  );
  const allNodeIds = useMemo(() => visibleStacks.flatMap((stack) => stack.nodeIds), [visibleStacks]);
  const visibleRowIds = useMemo(
    () => visibleStacks.flatMap((stack) => (isCollapsed(stack.stack) ? [] : stack.rows.map((row) => row.id))),
    [isCollapsed, visibleStacks]
  );

  const handleSelect = useCallback(
    (id: string, modifiers: LayerSelectionModifiers) => {
      const next = selectLayerInPanel(panelState, id, modifiers.range ? visibleRowIds : allNodeIds, modifiers);
      publishLayerPanelSelection(next);
      if (next.primaryId !== selectedLayerId) {
        dispatch({ id: next.primaryId, type: 'setCanvasSelectedLayer' });
      }
    },
    [allNodeIds, dispatch, panelState, selectedLayerId, visibleRowIds]
  );

  const handleToggleCollapse = useCallback(
    (stack: LayerStackKind) => toggleLayerStackCollapsed(projectId, selectedLayerId, stack),
    [projectId, selectedLayerId]
  );
  const handleToggleExpanded = useCallback(
    (groupId: string) => setLayerGroupExpanded(projectId, selectedLayerId, [groupId]),
    [projectId, selectedLayerId]
  );
  const handleExpandGroup = useCallback(
    (groupId: string) => setLayerGroupExpanded(projectId, selectedLayerId, [groupId], true),
    [projectId, selectedLayerId]
  );

  return (
    <Stack h="full">
      <LayersPanelHeader />
      {selectedIds.length > 1 ? (
        <LayerMultiSelectionActions
          document={document}
          editingLocked={editingLocked}
          engine={engine}
          projectId={projectId}
          selectedIds={selectedIds}
        />
      ) : null}
      {visibleStacks.length === 0 ? (
        <Flex
          align="center"
          borderColor="border.subtle"
          borderStyle="dashed"
          borderWidth="1px"
          color="fg.subtle"
          direction="column"
          gap="2"
          justify="center"
          minH="8rem"
          p="4"
          rounded="md"
        >
          <Icon as={LayersIcon} boxSize="6" />
          <Text fontSize="2xs" textAlign="center">
            {t('widgets.layers.empty')}
          </Text>
        </Flex>
      ) : (
        <Stack gap="3">
          {visibleStacks.map((stack) => (
            <LayerStackSection
              key={stack.stack}
              dispatch={dispatch}
              document={document}
              engine={engine}
              isCollapsed={isCollapsed(stack.stack)}
              selectedIds={selectedIds}
              selectedLayerId={selectedLayerId}
              stack={stack}
              onExpandGroup={handleExpandGroup}
              onSelect={handleSelect}
              onToggleCollapse={handleToggleCollapse}
              onToggleExpanded={handleToggleExpanded}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
};
