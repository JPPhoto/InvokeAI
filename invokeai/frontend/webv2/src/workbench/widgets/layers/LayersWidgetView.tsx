import type { WidgetViewProps } from '@workbench/widgetContracts';

import { Flex, Icon, Stack, Text } from '@chakra-ui/react';
import { getDocumentIndex } from '@workbench/canvas-engine/api';
import { setLayerPanelFilter, useLayerPanelState } from '@workbench/layerPanelState';
import { useCanvasProjectMutationDispatch } from '@workbench/useCanvasProjectMutationDispatch';
import { useCanvasDocumentEditingLocked } from '@workbench/widgets/canvas/engineStoreHooks';
import { useCanvasEngine } from '@workbench/widgets/canvas/useCanvasEngine';
import { useActiveProjectId, useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { LayersIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { LayerSurfaceAnchor } from './layerRowCommands';
import type { LayerColorPaneLayout, LayerEditorPaneLayout, LayerTreeTabId } from './panes/editorPaneLayout';

import { LayerMultiSelectionActions } from './LayerMultiSelectionActions';
import { LAYER_PANEL_DEGRADE_THRESHOLD } from './layerPanelRows';
import { useCurrentLayerPropertiesRequest } from './layerPropertiesRequestStore';
import { anchorFromPoint } from './layerRowCommands';
import { AddLayerContextMenu, LayersHeaderActions } from './LayersHeaderActions';
import { LayersPanelFooter } from './LayersPanelFooter';
import { LayersTree } from './LayersTree';
import { buildLayerStackRows } from './layerTreeRows';
import {
  areColorPaneLayoutsEqual,
  areLayerEditorPaneLayoutsEqual,
  readColorPaneLayout,
  readLayerEditorPaneLayout,
  readLayerTreeTab,
} from './panes/editorPaneLayout';
import { HistoryPane } from './panes/HistoryPane';
import { LAYER_TREE_PANEL_ID, LayerColorPane, LayerEditorPanes, LayerTreeStrip } from './panes/LayerEditorPanes';

/**
 * The layers panel: the Color pane at the top, then the flexible middle region tabbed between
 * the virtualized tree of the four stacks (with its selection toolbar and footer) and the edit
 * history, and the editor panes (Properties, Transform, Overview) at the bottom — the selected
 * layer's own editors live in the Properties pane. Regions keep their geometry; their controls
 * disable instead of appearing and disappearing.
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
  const treeTab = useActiveProjectSelector((project) =>
    readLayerTreeTab(project.widgetInstances[runtime.instanceId]?.state.values ?? {})
  );
  const handleTreeTab = useCallback((tab: LayerTreeTabId) => runtime.state.patch({ treeTab: tab }), [runtime.state]);
  // A properties request (canvas context menu) must reach the tree, which only
  // mounts on the Layers tab — switch back so the reveal actually happens.
  const propertiesRequest = useCurrentLayerPropertiesRequest();
  useEffect(() => {
    if (propertiesRequest && treeTab === 'history') {
      runtime.state.patch({ treeTab: 'layers' });
    }
  }, [propertiesRequest, runtime.state, treeTab]);
  const revealProperties = useCallback(
    (layerId: string) => {
      dispatch({ id: layerId, type: 'setCanvasSelectedLayer' });
      runtime.state.patch({ editorPanes: { ...paneLayout, activePane: 'properties', isCollapsed: false } });
    },
    [dispatch, paneLayout, runtime.state]
  );
  // Right-click on empty tree space offers the add-layer menu; rows and stack
  // headers preventDefault their own menus first, so they always win.
  const [addMenuAnchor, setAddMenuAnchor] = useState<LayerSurfaceAnchor | null>(null);
  const handleEmptyAreaContextMenu = useCallback((event: MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || (event.target as HTMLElement).closest('[role="treeitem"]')) {
      return;
    }
    event.preventDefault();
    setAddMenuAnchor(anchorFromPoint(event.clientX, event.clientY));
  }, []);
  const closeAddMenu = useCallback(() => setAddMenuAnchor(null), []);

  return (
    <Stack gap="1" h="full" minH="0">
      <LayerColorPane layout={colorPaneLayout} onLayoutChange={handleColorPaneLayout} />
      <LayerTreeStrip activeTab={treeTab} onSelectTab={handleTreeTab}>
        <LayersHeaderActions />
      </LayerTreeStrip>
      <Flex
        aria-labelledby={`layer-tree-tab-${treeTab}`}
        direction="column"
        flex="1"
        id={LAYER_TREE_PANEL_ID}
        // The toolbar (40px) + tree floor (128px) + footer (40px); anything
        // less lets the unshrinkable rows paint under the editor panes.
        minH="13rem"
        overflow="hidden"
        role="tabpanel"
      >
        {treeTab === 'history' ? (
          <HistoryPane />
        ) : (
          <>
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
                onContextMenu={handleEmptyAreaContextMenu}
              >
                <Icon as={LayersIcon} boxSize="6" />
                <Text fontSize="2xs" textAlign="center">
                  {t('widgets.layers.empty')}
                </Text>
              </Flex>
            ) : (
              <Flex direction="column" flex="1" minH="8rem" onContextMenu={handleEmptyAreaContextMenu}>
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
              filter={panel.filter}
              groupCount={counts.groups}
              leafCount={counts.leaves}
              selectedCount={panel.selectedIds.length}
              onFilterChange={handleFilter}
            />
            {addMenuAnchor ? <AddLayerContextMenu anchor={addMenuAnchor} onClose={closeAddMenu} /> : null}
          </>
        )}
      </Flex>
      <LayerEditorPanes layout={paneLayout} onLayoutChange={handlePaneLayout} />
    </Stack>
  );
};
