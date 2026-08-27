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
 * Isolation narrows the frame to one leaf; it never draws a leaf the document itself would not
 * draw, so a disabled or hidden isolated leaf produces an empty plan.
 */
export const planScreenComposition = (
  leaves: readonly SemanticLeafV2[],
  view: CanvasScreenViewState
): ScreenCompositionPlan => {
  const drawn: SemanticLeafV2[] = [];
  for (const stack of LAYER_STACK_ORDER) {
    for (let index = leaves.length - 1; index >= 0; index -= 1) {
      const leaf = leaves[index]!;
      if (leaf.stack !== stack || !leaf.contributionEnabled || leaf.documentHidden) {
        continue;
      }
      if (view.isolationLayerId === null ? isStackShown(stack, view) : leaf.id === view.isolationLayerId) {
        drawn.push(leaf);
      }
    }
  }
  return { isolationLayerId: view.isolationLayerId, leaves: drawn };
};
