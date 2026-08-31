/** Pure layout contract for the Layers widget's editor panes; the manifest seeds it, so no React here. */

export type LayerEditorPaneId = 'properties' | 'transform';

export interface LayerEditorPaneLayout {
  activePane: LayerEditorPaneId;
  isCollapsed: boolean;
  sizePx: number;
}

export const LAYER_EDITOR_PANE_MIN_SIZE_PX = 140;
export const LAYER_EDITOR_PANE_MAX_SIZE_PX = 560;

export const LAYER_EDITOR_PANE_DEFAULTS: LayerEditorPaneLayout = {
  activePane: 'properties',
  isCollapsed: false,
  sizePx: 300,
};

export const clampLayerEditorPaneSize = (sizePx: number): number =>
  Math.min(LAYER_EDITOR_PANE_MAX_SIZE_PX, Math.max(LAYER_EDITOR_PANE_MIN_SIZE_PX, Math.round(sizePx)));

const isPaneId = (value: unknown): value is LayerEditorPaneId => value === 'properties' || value === 'transform';

/** The persisted widget values are untyped; anything malformed falls back per field. */
export const readLayerEditorPaneLayout = (values: Record<string, unknown>): LayerEditorPaneLayout => {
  const raw = values.editorPanes;
  const layout = typeof raw === 'object' && raw !== null ? (raw as Partial<LayerEditorPaneLayout>) : {};
  return {
    activePane: isPaneId(layout.activePane) ? layout.activePane : LAYER_EDITOR_PANE_DEFAULTS.activePane,
    isCollapsed: typeof layout.isCollapsed === 'boolean' ? layout.isCollapsed : LAYER_EDITOR_PANE_DEFAULTS.isCollapsed,
    sizePx:
      typeof layout.sizePx === 'number' && Number.isFinite(layout.sizePx)
        ? clampLayerEditorPaneSize(layout.sizePx)
        : LAYER_EDITOR_PANE_DEFAULTS.sizePx,
  };
};

export const areLayerEditorPaneLayoutsEqual = (a: LayerEditorPaneLayout, b: LayerEditorPaneLayout): boolean =>
  a.activePane === b.activePane && a.isCollapsed === b.isCollapsed && a.sizePx === b.sizePx;
