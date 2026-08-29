import type { CanvasLayerContract, CanvasNodeEntry, LayerStackKind } from '@workbench/canvas-engine/api';

import { isExportableRasterLayer, isGroupNode, isNodeHidden } from '@workbench/canvas-engine/api';

/** A stack-header action id. Extend this + `getStackActions` to add a new action. */
export type StackActionId = 'mergeVisible' | 'exportPsd' | 'toggleVisibility' | 'new';

/**
 * The right-aligned actions for a stack, in left-to-right render order (the "New" action sits
 * rightmost, nearest the panel's own add-layer menu). Only the raster stack offers "merge
 * visible" + "export to PSD"; every stack offers hide/show-all + new.
 */
export const getStackActions = (stack: LayerStackKind): StackActionId[] => {
  const actions: StackActionId[] = [];
  if (stack === 'raster') {
    actions.push('mergeVisible', 'exportPsd');
  }
  actions.push('toggleVisibility', 'new');
  return actions;
};

/** Whether the raster stack's "export to PSD" action has anything to export. */
export const canExportRasterPsd = (leaves: readonly CanvasLayerContract[]): boolean =>
  leaves.some(isExportableRasterLayer);

export type StackVisibilityAxis = 'enabled' | 'hidden';

/**
 * Which axis a stack's show/hide-all button drives. The three overlay stacks drive the DISPLAY
 * axis: their layers are drawn to show where an effect applies, so getting them out of the way
 * must not change the image. The raster stack IS the generation input, so it drives enablement.
 */
export const stackVisibilityAxis = (stack: LayerStackKind): StackVisibilityAxis =>
  stack === 'raster' ? 'enabled' : 'hidden';

const isEntryVisible = (entry: CanvasNodeEntry, axis: StackVisibilityAxis): boolean =>
  axis === 'hidden'
    ? !entry.ancestorsHidden && !isNodeHidden(entry.node)
    : entry.ancestorsEnabled && entry.node.isEnabled;

const isOwnVisible = (entry: CanvasNodeEntry, axis: StackVisibilityAxis): boolean =>
  axis === 'hidden' ? !isNodeHidden(entry.node) : entry.node.isEnabled;

/** True when every leaf of the stack is effectively visible on `axis`. Empty ⇒ true. */
export const isStackAllVisible = (entries: readonly CanvasNodeEntry[], axis: StackVisibilityAxis): boolean =>
  entries.every((entry) => isGroupNode(entry.node) || isEntryVisible(entry, axis));

/**
 * Plans a stack show/hide-all toggle as ONE reversible bulk edit. When every leaf is visible the
 * roots alone are turned off, so descendants keep their own flags; otherwise every node that is
 * off in its own right is turned on, so nothing stays gated behind an ancestor.
 */
export const planStackVisibilityToggle = (
  entries: readonly CanvasNodeEntry[],
  axis: StackVisibilityAxis
): { ids: string[]; nextVisible: boolean } => {
  const nextVisible = !isStackAllVisible(entries, axis);
  const targets = nextVisible
    ? entries.filter((entry) => !isOwnVisible(entry, axis))
    : entries.filter((entry) => entry.parentId === null);
  return { ids: targets.map((entry) => entry.node.id), nextVisible };
};
