import type { DockviewApi, GridviewApi, IDockviewReactProps, IGridviewReactProps } from 'dockview';
import { DockviewReact, GridviewReact, LayoutPriority, Orientation } from 'dockview';
import { CanvasLayersPanel } from 'features/controlLayers/components/CanvasLayersPanelContent';
import { CanvasLaunchpadPanel } from 'features/controlLayers/components/SimpleSession/CanvasLaunchpadPanel';
import { BoardsPanel } from 'features/gallery/components/BoardsListPanelContent';
import { GalleryPanel } from 'features/gallery/components/Gallery';
import { GenerationProgressPanel } from 'features/gallery/components/ImageViewer/GenerationProgressPanel';
import { ImageViewerPanel } from 'features/gallery/components/ImageViewer/ImageViewerPanel';
import { FloatingCanvasLeftPanelButtons } from 'features/ui/components/FloatingLeftPanelButtons';
import { FloatingRightPanelButtons } from 'features/ui/components/FloatingRightPanelButtons';
import type {
  AutoLayoutDockviewComponents,
  AutoLayoutGridviewComponents,
  PanelParameters,
  RootLayoutGridviewComponents,
} from 'features/ui/layouts/auto-layout-context';
import { AutoLayoutProvider, useAutoLayoutContext, withPanelContainer } from 'features/ui/layouts/auto-layout-context';
import { TabWithoutCloseButton } from 'features/ui/layouts/TabWithoutCloseButton';
import type { TabName } from 'features/ui/store/uiTypes';
import { dockviewTheme } from 'features/ui/styles/theme';
import { memo, useCallback, useEffect } from 'react';

import { CanvasTabLeftPanel } from './CanvasTabLeftPanel';
import { CanvasWorkspacePanel } from './CanvasWorkspacePanel';
import { navigationApi } from './navigation-api';
import { PanelHotkeysLogical } from './PanelHotkeysLogical';
import {
  BOARD_PANEL_MIN_HEIGHT_PX,
  BOARDS_PANEL_ID,
  CANVAS_BOARD_PANEL_DEFAULT_HEIGHT_PX,
  DEFAULT_TAB_ID,
  GALLERY_PANEL_DEFAULT_HEIGHT_PX,
  GALLERY_PANEL_ID,
  GALLERY_PANEL_MIN_HEIGHT_PX,
  LAUNCHPAD_PANEL_ID,
  LAYERS_PANEL_ID,
  LAYERS_PANEL_MIN_HEIGHT_PX,
  LEFT_PANEL_ID,
  LEFT_PANEL_MIN_SIZE_PX,
  MAIN_PANEL_ID,
  PROGRESS_PANEL_ID,
  RIGHT_PANEL_ID,
  RIGHT_PANEL_MIN_SIZE_PX,
  SETTINGS_PANEL_ID,
  TAB_WITH_LAUNCHPAD_ICON_ID,
  TAB_WITH_PROGRESS_INDICATOR_ID,
  VIEWER_PANEL_ID,
  WORKSPACE_PANEL_ID,
} from './shared';
import { TabWithLaunchpadIcon } from './TabWithLaunchpadIcon';
import { TabWithoutCloseButtonAndWithProgressIndicator } from './TabWithoutCloseButtonAndWithProgressIndicator';

const tabComponents = {
  [DEFAULT_TAB_ID]: TabWithoutCloseButton,
  [TAB_WITH_PROGRESS_INDICATOR_ID]: TabWithoutCloseButtonAndWithProgressIndicator,
  [TAB_WITH_LAUNCHPAD_ICON_ID]: TabWithLaunchpadIcon,
};

const mainPanelComponents: AutoLayoutDockviewComponents = {
  [LAUNCHPAD_PANEL_ID]: withPanelContainer(CanvasLaunchpadPanel),
  [WORKSPACE_PANEL_ID]: withPanelContainer(CanvasWorkspacePanel),
  [VIEWER_PANEL_ID]: withPanelContainer(ImageViewerPanel),
  [PROGRESS_PANEL_ID]: withPanelContainer(GenerationProgressPanel),
};

const initializeCenterPanelLayout = (tab: TabName, api: DockviewApi) => {
  navigationApi.registerContainer(tab, 'main', api, () => {
    const launchpad = api.addPanel<PanelParameters>({
      id: LAUNCHPAD_PANEL_ID,
      component: LAUNCHPAD_PANEL_ID,
      title: 'Launchpad',
      tabComponent: TAB_WITH_LAUNCHPAD_ICON_ID,
      params: {
        tab,
        focusRegion: 'launchpad',
      },
    });

    api.addPanel<PanelParameters>({
      id: WORKSPACE_PANEL_ID,
      component: WORKSPACE_PANEL_ID,
      title: 'Canvas',
      tabComponent: DEFAULT_TAB_ID,
      params: {
        tab,
        focusRegion: 'canvas',
      },
      position: {
        direction: 'within',
        referencePanel: launchpad.id,
      },
    });

    api.addPanel<PanelParameters>({
      id: VIEWER_PANEL_ID,
      component: VIEWER_PANEL_ID,
      title: 'Image Viewer',
      tabComponent: DEFAULT_TAB_ID,
      params: {
        tab,
        focusRegion: 'viewer',
      },
      position: {
        direction: 'within',
        referencePanel: launchpad.id,
      },
    });

    launchpad.api.setActive();
  });
};

const MainPanel = memo(() => {
  const { tab } = useAutoLayoutContext();

  const onReady = useCallback<IDockviewReactProps['onReady']>(
    ({ api }) => {
      initializeCenterPanelLayout(tab, api);
    },
    [tab]
  );
  return (
    <>
      <DockviewReact
        disableDnd={true}
        locked={true}
        disableFloatingGroups={true}
        dndEdges={false}
        components={mainPanelComponents}
        onReady={onReady}
        theme={dockviewTheme}
        tabComponents={tabComponents}
      />
      <FloatingCanvasLeftPanelButtons />
      <FloatingRightPanelButtons />
      <PanelHotkeysLogical />
    </>
  );
});
MainPanel.displayName = 'MainPanel';

const rightPanelComponents: AutoLayoutGridviewComponents = {
  [BOARDS_PANEL_ID]: withPanelContainer(BoardsPanel),
  [GALLERY_PANEL_ID]: withPanelContainer(GalleryPanel),
  [LAYERS_PANEL_ID]: withPanelContainer(CanvasLayersPanel),
};

const initializeRightPanelLayout = (tab: TabName, api: GridviewApi) => {
  navigationApi.registerContainer(tab, 'right', api, () => {
    const gallery = api.addPanel<PanelParameters>({
      id: GALLERY_PANEL_ID,
      component: GALLERY_PANEL_ID,
      minimumWidth: RIGHT_PANEL_MIN_SIZE_PX,
      minimumHeight: GALLERY_PANEL_MIN_HEIGHT_PX,
      params: {
        tab,
        focusRegion: 'gallery',
      },
    });

    const boards = api.addPanel<PanelParameters>({
      id: BOARDS_PANEL_ID,
      component: BOARDS_PANEL_ID,
      minimumHeight: BOARD_PANEL_MIN_HEIGHT_PX,
      params: {
        tab,
        focusRegion: 'boards',
      },
      position: {
        direction: 'above',
        referencePanel: gallery.id,
      },
    });

    api.addPanel<PanelParameters>({
      id: LAYERS_PANEL_ID,
      component: LAYERS_PANEL_ID,
      minimumHeight: LAYERS_PANEL_MIN_HEIGHT_PX,
      params: {
        tab,
        focusRegion: 'layers',
      },
      position: {
        direction: 'below',
        referencePanel: gallery.id,
      },
    });

    gallery.api.setSize({ height: GALLERY_PANEL_DEFAULT_HEIGHT_PX });
    boards.api.setSize({ height: CANVAS_BOARD_PANEL_DEFAULT_HEIGHT_PX });
  });
};

const RightPanel = memo(() => {
  const { tab } = useAutoLayoutContext();

  const onReady = useCallback<IGridviewReactProps['onReady']>(
    ({ api }) => {
      initializeRightPanelLayout(tab, api);
    },
    [tab]
  );
  return (
    <GridviewReact
      className="dockview-theme-invoke"
      orientation={Orientation.VERTICAL}
      components={rightPanelComponents}
      onReady={onReady}
    />
  );
});
RightPanel.displayName = 'RightPanel';

const leftPanelComponents: AutoLayoutGridviewComponents = {
  [SETTINGS_PANEL_ID]: withPanelContainer(CanvasTabLeftPanel),
};

const initializeLeftPanelLayout = (tab: TabName, api: GridviewApi) => {
  navigationApi.registerContainer(tab, 'left', api, () => {
    api.addPanel<PanelParameters>({
      id: SETTINGS_PANEL_ID,
      component: SETTINGS_PANEL_ID,
      params: {
        tab,
        focusRegion: 'settings',
      },
    });
  });
};

const LeftPanel = memo(() => {
  const { tab } = useAutoLayoutContext();

  const onReady = useCallback<IGridviewReactProps['onReady']>(
    ({ api }) => {
      initializeLeftPanelLayout(tab, api);
    },
    [tab]
  );
  return (
    <GridviewReact
      className="dockview-theme-invoke"
      orientation={Orientation.VERTICAL}
      components={leftPanelComponents}
      onReady={onReady}
    />
  );
});
LeftPanel.displayName = 'LeftPanel';

const rootPanelComponents: RootLayoutGridviewComponents = {
  [LEFT_PANEL_ID]: LeftPanel,
  [MAIN_PANEL_ID]: MainPanel,
  [RIGHT_PANEL_ID]: RightPanel,
};

const initializeRootPanelLayout = (tab: TabName, api: GridviewApi) => {
  navigationApi.registerContainer(tab, 'root', api, () => {
    const main = api.addPanel({
      id: MAIN_PANEL_ID,
      component: MAIN_PANEL_ID,
      priority: LayoutPriority.High,
    });

    const left = api.addPanel({
      id: LEFT_PANEL_ID,
      component: LEFT_PANEL_ID,
      minimumWidth: LEFT_PANEL_MIN_SIZE_PX,
      priority: LayoutPriority.Low,
      position: {
        direction: 'left',
        referencePanel: main.id,
      },
    });

    const right = api.addPanel({
      id: RIGHT_PANEL_ID,
      component: RIGHT_PANEL_ID,
      minimumWidth: RIGHT_PANEL_MIN_SIZE_PX,
      priority: LayoutPriority.Low,
      position: {
        direction: 'right',
        referencePanel: main.id,
      },
    });

    left.api.setSize({ width: LEFT_PANEL_MIN_SIZE_PX });
    right.api.setSize({ width: RIGHT_PANEL_MIN_SIZE_PX });
  });
};

export const CanvasTabAutoLayout = memo(() => {
  const onReady = useCallback<IGridviewReactProps['onReady']>(({ api }) => {
    initializeRootPanelLayout('canvas', api);
  }, []);

  useEffect(
    () => () => {
      navigationApi.unregisterTab('canvas');
    },
    []
  );

  return (
    <AutoLayoutProvider tab="canvas">
      <GridviewReact
        className="dockview-theme-invoke"
        components={rootPanelComponents}
        onReady={onReady}
        orientation={Orientation.VERTICAL}
      />
    </AutoLayoutProvider>
  );
});
CanvasTabAutoLayout.displayName = 'CanvasTabAutoLayout';
