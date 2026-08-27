import type { LayerStackKind } from '@workbench/canvas-engine/api';

import { Flex, Icon, Stack, Text } from '@chakra-ui/react';
import {
  publishLayerPanelSelection,
  selectLayerInPanel,
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

import type { LayerGroup } from './layerGroups';

import { groupLayers } from './layerGroups';
import { LayerGroupSection } from './LayerGroupSection';
import { LayerMultiSelectionActions } from './LayerMultiSelectionActions';
import { isLayerPropertiesGroupRequested, useCurrentLayerPropertiesRequest } from './layerPropertiesRequestStore';
import { LayersPanelHeader } from './LayersPanelHeader';

/**
 * The layers panel: a fixed Photoshop-style header region (selected layer's
 * opacity + blend mode, global denoising strength) above the layer list, which
 * is split into type groups (inpaint masks / regional guidance / control /
 * raster — legacy display order). Each group is a within-group drag-to-reorder
 * list mapped onto the single global z-ordered `layers` array.
 */
export const LayersWidgetView = () => {
  const { t } = useTranslation();
  const engine = useCanvasEngine();
  const projectId = useActiveProjectId();
  const dispatch = useCanvasProjectMutationDispatch();
  const editingLocked = useCanvasDocumentEditingLocked(engine);
  const propertiesRequest = useCurrentLayerPropertiesRequest();
  const { layers, selectedLayerId } = useActiveProjectSelector(
    (project) => ({
      layers: project.canvas.document.layers,
      selectedLayerId: project.canvas.document.selectedLayerId,
    }),
    (left, right) => left.layers === right.layers && left.selectedLayerId === right.selectedLayerId
  );

  const groups = useMemo(() => groupLayers(layers), [layers]);
  const panelState = useLayerPanelState(projectId, selectedLayerId);
  const isCollapsed = (group: LayerGroup): boolean =>
    panelState.collapsedStacks.includes(group.key) && !isLayerPropertiesGroupRequested(propertiesRequest, group.layers);
  const allLayerIds = useMemo(() => groups.flatMap((group) => group.layers.map((layer) => layer.id)), [groups]);
  const visibleLayerIds = groups.flatMap((group) => (isCollapsed(group) ? [] : group.layers.map((layer) => layer.id)));
  const selectedIds = panelState.selectedIds;

  const handleSelectLayer = useCallback(
    (layerId: string, modifiers: LayerSelectionModifiers) => {
      const next = selectLayerInPanel(panelState, layerId, modifiers.range ? visibleLayerIds : allLayerIds, modifiers);
      publishLayerPanelSelection(next);
      if (next.primaryId !== selectedLayerId) {
        dispatch({ id: next.primaryId, type: 'setCanvasSelectedLayer' });
      }
    },
    [allLayerIds, dispatch, panelState, selectedLayerId, visibleLayerIds]
  );

  const handleToggleCollapse = useCallback(
    (stack: LayerStackKind) => toggleLayerStackCollapsed(projectId, selectedLayerId, stack),
    [projectId, selectedLayerId]
  );

  return (
    <Stack h="full">
      <LayersPanelHeader />
      {selectedIds.length > 1 ? (
        <LayerMultiSelectionActions
          editingLocked={editingLocked}
          engine={engine}
          layers={layers}
          projectId={projectId}
          selectedIds={selectedIds}
        />
      ) : null}
      {groups.length === 0 ? (
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
          {groups.map((group) => (
            <LayerGroupSection
              key={group.key}
              dispatch={dispatch}
              engine={engine}
              groupKey={group.key}
              groupLayers={group.layers}
              isCollapsed={isCollapsed(group)}
              layers={layers}
              onSelectLayer={handleSelectLayer}
              onToggleCollapse={handleToggleCollapse}
              selectedIds={selectedIds}
              selectedLayerId={selectedLayerId}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
};
