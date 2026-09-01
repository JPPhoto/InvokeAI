import type { LayerPanelDensity } from '@workbench/layerPanelState';
import type { WidgetViewProps } from '@workbench/widgetContracts';

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

import type { LayerColorPaneLayout, LayerEditorPaneLayout } from './panes/editorPaneLayout';

import { LayerMultiSelectionActions } from './LayerMultiSelectionActions';
import { LAYER_PANEL_DEGRADE_THRESHOLD } from './layerPanelRows';
import { LayersPanelFooter } from './LayersPanelFooter';
import { LayersTree } from './LayersTree';
import { buildLayerStackRows } from './layerTreeRows';
import {
  areColorPaneLayoutsEqual,
  areLayerEditorPaneLayoutsEqual,
  readColorPaneLayout,
  readLayerEditorPaneLayout,
} from './panes/editorPaneLayout';
import { LayerColorPane, LayerEditorPanes } from './panes/LayerEditorPanes';

/**
 * The layers panel: the Color pane at the top, a fixed selection toolbar, the virtualized tree
 * of the four stacks, a fixed footer (summary, filter, density), and the editor panes at the
 * bottom — the selected layer's own editors live in the Properties pane. Regions keep their
 * geometry; their controls disable instead of appearing and disappearing.
 */
export const LayersWidgetView = ({ runtime }: WidgetViewProps) => {
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
  const paneLayout = useActiveProjectSelector(
    (project) => readLayerEditorPaneLayout(project.widgetInstances[runtime.instanceId]?.state.values ?? {}),
    areLayerEditorPaneLayoutsEqual
  );
  const handlePaneLayout = useCallback(
    (next: LayerEditorPaneLayout) => runtime.state.patch({ editorPanes: next }),
    [runtime.state]
  );
  const colorPaneLayout = useActiveProjectSelector(
    (project) => readColorPaneLayout(project.widgetInstances[runtime.instanceId]?.state.values ?? {}),
    areColorPaneLayoutsEqual
  );
  const handleColorPaneLayout = useCallback(
    (next: LayerColorPaneLayout) => runtime.state.patch({ colorPane: next }),
    [runtime.state]
  );
  const revealProperties = useCallback(
    (layerId: string) => {
      dispatch({ id: layerId, type: 'setCanvasSelectedLayer' });
      runtime.state.patch({ editorPanes: { ...paneLayout, activePane: 'properties', isCollapsed: false } });
    },
    [dispatch, paneLayout, runtime.state]
  );

  return (
    <Stack gap="1" h="full" minH="0">
      <LayerColorPane layout={colorPaneLayout} onLayoutChange={handleColorPaneLayout} />
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
        <Flex direction="column" flex="1" minH="8rem">
          <LayersTree
            degraded={degraded}
            dispatch={dispatch}
            document={document}
            editingLocked={editingLocked}
            engine={engine}
            panel={panel}
            projectId={projectId}
            stacks={stacks}
            onRevealProperties={revealProperties}
          />
        </Flex>
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
      <LayerEditorPanes layout={paneLayout} onLayoutChange={handlePaneLayout} />
    </Stack>
  );
};
