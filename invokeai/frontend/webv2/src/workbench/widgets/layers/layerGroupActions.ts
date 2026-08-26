import type { CanvasLayerContract, LayerStackKind } from '@workbench/canvas-engine/api';

import { isExportableRasterLayer, isHideableLayer, isLayerHidden } from '@workbench/canvas-engine/api';

/** A group-header action id. Extend this + `getGroupActions` to add a new action. */
export type GroupActionId = 'mergeVisible' | 'exportPsd' | 'toggleVisibility' | 'new';

/**
 * The right-aligned actions for a group, in left-to-right render order (the "New"
 * action sits rightmost, nearest the panel's own add-layer menu). Only the raster
 * group offers "merge visible" + "export to PSD"; every group offers
 * hide/show-all + new.
 */
export const getGroupActions = (groupKey: LayerStackKind): GroupActionId[] => {
  const actions: GroupActionId[] = [];
  if (groupKey === 'raster') {
    actions.push('mergeVisible', 'exportPsd');
  }
  actions.push('toggleVisibility', 'new');
  return actions;
};

/** Whether the raster group's "export to PSD" action has anything to export. */
export const canExportRasterPsd = (layers: readonly CanvasLayerContract[]): boolean =>
  layers.some(isExportableRasterLayer);

/** A single layer's target enablement, for the bulk `setCanvasLayersEnabled` action. */
export interface LayerVisibilityUpdate {
  id: string;
  isEnabled: boolean;
}

/** A single layer's target display visibility, for the bulk `setCanvasLayersHidden` action. */
export interface LayerHiddenUpdate {
  id: string;
  isHidden: boolean;
}

/**
 * Which axis a group's show/hide-all button drives.
 *
 * The three overlay groups drive the DISPLAY axis: their layers are drawn to
 * show you where an effect applies, so getting them out of the way must not
 * change the image. The raster group has no display axis — the raster stack IS
 * the generation input, so hiding a raster layer and disabling it are the same
 * act — and drives enablement.
 */
export const groupVisibilityAxis = (groupKey: LayerStackKind): 'enabled' | 'hidden' =>
  groupKey === 'raster' ? 'enabled' : 'hidden';

/** True when every layer in the group is currently visible on the group's own axis. Empty ⇒ true. */
export const isGroupAllVisible = (
  groupLayers: readonly CanvasLayerContract[],
  axis: 'enabled' | 'hidden' = 'enabled'
): boolean =>
  axis === 'hidden'
    ? groupLayers.every((layer) => !isLayerHidden(layer))
    : groupLayers.every((layer) => layer.isEnabled);

/**
 * Plans a group show/hide-all toggle as ONE reversible bulk action: if every
 * layer is currently visible, hide them all; otherwise show them all (legacy
 * `CanvasEntityType` toggle semantics). `forward` sets the shared target;
 * `inverse` restores each layer's prior state verbatim, so undo is a single
 * history entry.
 */
export const planGroupVisibilityToggle = (
  groupLayers: readonly CanvasLayerContract[]
): { forward: LayerVisibilityUpdate[]; inverse: LayerVisibilityUpdate[]; nextVisible: boolean } => {
  const nextVisible = !isGroupAllVisible(groupLayers);
  return {
    forward: groupLayers.map((layer) => ({ id: layer.id, isEnabled: nextVisible })),
    inverse: groupLayers.map((layer) => ({ id: layer.id, isEnabled: layer.isEnabled })),
    nextVisible,
  };
};

/** The display-axis counterpart of {@link planGroupVisibilityToggle}. */
export const planGroupHiddenToggle = (
  groupLayers: readonly CanvasLayerContract[]
): { forward: LayerHiddenUpdate[]; inverse: LayerHiddenUpdate[]; nextVisible: boolean } => {
  const hideable = groupLayers.filter(isHideableLayer);
  const nextVisible = !isGroupAllVisible(hideable, 'hidden');
  return {
    forward: hideable.map((layer) => ({ id: layer.id, isHidden: !nextVisible })),
    inverse: hideable.map((layer) => ({ id: layer.id, isHidden: isLayerHidden(layer) })),
    nextVisible,
  };
};

// Merge-visible contributor selection lives in the engine's document layer
// Canvas execution uses the same legacy-parity eligibility rules.
