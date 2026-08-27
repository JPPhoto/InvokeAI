import type { LayerStackKind, OverlayStackKind } from '@workbench/canvas-engine/document/layerStacks';

import { LAYER_STACK_ORDER } from '@workbench/canvas-engine/document/layerStacks';

import type { SemanticLeafV2 } from './semanticLeaf';

/** Screen-only state that never enters the document: overlay stack switches and isolation. */
export interface CanvasScreenViewState {
  readonly showOverlayStacks: Readonly<Record<OverlayStackKind, boolean>>;
  readonly isolationLayerId: string | null;
}

/** Leaves to draw, bottom first, after the view state is applied to the document facts. */
export interface ScreenCompositionPlan {
  readonly leaves: readonly SemanticLeafV2[];
  readonly isolationLayerId: string | null;
}

/** Every overlay stack visible: the view state of a screen with no stack switched off. */
export const ALL_OVERLAY_STACKS_SHOWN: Readonly<Record<OverlayStackKind, boolean>> = {
  control: true,
  inpaint_mask: true,
  regional_guidance: true,
};

const isStackShown = (stack: LayerStackKind, view: CanvasScreenViewState): boolean =>
  stack === 'raster' || view.showOverlayStacks[stack];

/**
 * Whether document visibility admits a leaf to the screen. Isolation deliberately overrides both
 * contribution and display visibility because isolated operations act on the named layer itself.
 * Frame-demand planning consumes this same predicate so allocation and composition cannot drift.
 */
export const isLeafDrawableForScreen = (leaf: SemanticLeafV2, isIsolated: boolean): boolean =>
  isIsolated || (leaf.contributionEnabled && !leaf.documentHidden);

/** Isolation narrows the frame to one leaf and overrides the document's visibility flags. */
export const planScreenComposition = (
  leaves: readonly SemanticLeafV2[],
  view: CanvasScreenViewState
): ScreenCompositionPlan => {
  const drawn: SemanticLeafV2[] = [];
  for (const stack of LAYER_STACK_ORDER) {
    for (let index = leaves.length - 1; index >= 0; index -= 1) {
      const leaf = leaves[index]!;
      const isIsolated = view.isolationLayerId === leaf.id;
      if (leaf.stack !== stack || !isLeafDrawableForScreen(leaf, isIsolated)) {
        continue;
      }
      if (view.isolationLayerId === null ? isStackShown(stack, view) : isIsolated) {
        drawn.push(leaf);
      }
    }
  }
  return { isolationLayerId: view.isolationLayerId, leaves: drawn };
};
