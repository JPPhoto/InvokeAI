import type { LayerPanelDensity } from '@workbench/layerPanelState';

import { Flex, Icon, Stack, Text } from '@chakra-ui/react';
import { getDocumentIndex } from '@workbench/canvas-engine/api';
import { setLayerPanelDensity, setLayerPanelFilter, useLayerPanelState } from '@workbench/layerPanelState';
import { useCanvasProjectMutationDispatch } from '@workbench/useCanvasProjectMutationDispatch';
import { useCanvasDocumentEditingLocked } from '@workbench/widgets/canvas/engineStoreHooks';
import { useCanvasEngine } from '@workbench/widgets/canvas/useCanvasEngine';
import { useActiveProjectId, useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { LayersIcon } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { LayerMultiSelectionActions } from './LayerMultiSelectionActions';
import { LAYER_PANEL_DEGRADE_THRESHOLD } from './layerPanelRows';
import { LayersPanelFooter } from './LayersPanelFooter';
import { LayersPanelHeader } from './LayersPanelHeader';
import { LayersTree } from './LayersTree';
import { buildLayerStackRows } from './layerTreeRows';

/**
 * The layers panel: a fixed header (selected layer's opacity + blend mode, global denoising
 * strength), a fixed selection toolbar, the virtualized tree of the four stacks, and a fixed
 * footer (summary, filter, density). Regions keep their geometry; their controls disable instead
 * of appearing and disappearing.
 */
export const LayersWidgetView = () => {
  const { t } = useTranslation();
  const engine = useCanvasEngine();
  const projectId = useActiveProjectId();
  const dispatch = useCanvasProjectMutationDispatch();
  const editingLocked = useCanvasDocumentEditingLocked(engine);
  const document = useActiveProjectSelector((project) => project.canvas.document);
  const { selectedLayerId } = document;

  const panel = useLayerPanelState(projectId, selectedLayerId);
  const expandedGroupIds = useMemo(() => new Set(panel.expandedGroupIds), [panel.expandedGroupIds]);
  // Keyed on the forests, so a selection or bbox change never rebuilds a row.
  const stacks = useMemo(
    () => buildLayerStackRows(document.stacks, expandedGroupIds, panel.filter),
    [document.stacks, expandedGroupIds, panel.filter]
  );
  const nodeCount = getDocumentIndex(document).nodes.length;
  const degraded = nodeCount > LAYER_PANEL_DEGRADE_THRESHOLD;
  const counts = useMemo(
    () =>
      Object.values(stacks).reduce(
        (total, stack) => ({ groups: total.groups + stack.groupCount, leaves: total.leaves + stack.leafCount }),
        { groups: 0, leaves: 0 }
      ),
    [stacks]
  );

  const handleDensity = useCallback(
    (density: LayerPanelDensity) => setLayerPanelDensity(projectId, selectedLayerId, density),
    [projectId, selectedLayerId]
  );
  const handleFilter = useCallback(
    (filter: string) => setLayerPanelFilter(projectId, selectedLayerId, filter),
    [projectId, selectedLayerId]
  );

  return (
    <Stack gap="1" h="full" minH="0">
      <LayersPanelHeader />
      <LayerMultiSelectionActions
        document={document}
        editingLocked={editingLocked}
        engine={engine}
        projectId={projectId}
        selectedIds={panel.selectedIds}
      />
      {nodeCount === 0 ? (
        <Flex
          align="center"
          borderColor="border.subtle"
          borderStyle="dashed"
          borderWidth="1px"
          color="fg.subtle"
          direction="column"
          flex="1"
          gap="2"
          justify="center"
          minH="8rem"
          mx="2"
          p="4"
          rounded="md"
        >
          <Icon as={LayersIcon} boxSize="6" />
          <Text fontSize="2xs" textAlign="center">
            {t('widgets.layers.empty')}
          </Text>
        </Flex>
      ) : (
        <LayersTree
          degraded={degraded}
          dispatch={dispatch}
          document={document}
          editingLocked={editingLocked}
          engine={engine}
          panel={panel}
          projectId={projectId}
          stacks={stacks}
        />
      )}
      <LayersPanelFooter
        degraded={degraded}
        density={panel.density}
        filter={panel.filter}
        groupCount={counts.groups}
        leafCount={counts.leaves}
        selectedCount={panel.selectedIds.length}
        onDensityChange={handleDensity}
        onFilterChange={handleFilter}
      />
    </Stack>
  );
};
