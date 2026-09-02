/**
 * Group adjustment scopes: which contiguous runs of a flat drawn-leaf list
 * must composite through an isolated buffer so a group's adjustment stack can
 * apply to the composite (not to each member). Both renderers — the screen
 * compositor and the export/generation raster composite — consume the same
 * scope shape, so their isolation semantics cannot drift.
 *
 * The planners rely on one structural fact: any list derived from the
 * document's preorder (or its reversal) keeps every subtree contiguous, so a
 * group's drawn members always form one run.
 */

import type { CanvasAdjustmentsContract, CanvasDocumentContractV3 } from '@workbench/canvas-engine/contracts';

import { getDocumentIndex } from '@workbench/canvas-engine/document/documentIndex';
import { isGroupNode } from '@workbench/canvas-engine/document/documentTree';

import { isIdentityAdjustments } from './adjustments';

export interface GroupAdjustmentScope {
  readonly id: string;
  readonly adjustments: CanvasAdjustmentsContract;
  /** Contiguous [start, end) index range over the flat drawn list. */
  readonly start: number;
  readonly end: number;
  /** Nested scopes, each fully inside [start, end), in list order. */
  readonly children: readonly GroupAdjustmentScope[];
}

/**
 * The raster-stack groups whose adjustment stacks contribute (enabled group,
 * non-identity stack). Disabled groups drop out of drawing entirely upstream;
 * an identity stack composites pass-through by definition.
 */
export const collectAdjustedGroups = (
  document: CanvasDocumentContractV3
): ReadonlyMap<string, CanvasAdjustmentsContract> => {
  const adjusted = new Map<string, CanvasAdjustmentsContract>();
  for (const entry of getDocumentIndex(document).nodes) {
    if (
      entry.stack === 'raster' &&
      isGroupNode(entry.node) &&
      entry.node.adjustments &&
      !isIdentityAdjustments(entry.node.adjustments)
    ) {
      adjusted.set(entry.node.id, entry.node.adjustments);
    }
  }
  return adjusted;
};

interface OpenScope {
  id: string;
  adjustments: CanvasAdjustmentsContract;
  start: number;
  children: GroupAdjustmentScope[];
}

/**
 * Plans the nested scopes covering `items` (a flat drawn list; each item
 * carries its ancestor chain outermost-first). Items outside every adjusted
 * group produce no scope. Returns outermost scopes in list order.
 */
export const planGroupAdjustmentScopes = (
  items: readonly { readonly parentIds: readonly string[] }[],
  adjusted: ReadonlyMap<string, CanvasAdjustmentsContract>
): readonly GroupAdjustmentScope[] => {
  if (adjusted.size === 0) {
    return [];
  }
  const roots: GroupAdjustmentScope[] = [];
  const open: OpenScope[] = [];

  const closeTo = (depth: number, end: number): void => {
    while (open.length > depth) {
      const scope = open.pop()!;
      const closed: GroupAdjustmentScope = { ...scope, end };
      const parent = open[open.length - 1];
      (parent ? parent.children : roots).push(closed);
    }
  };

  items.forEach((item, index) => {
    const chain = item.parentIds.filter((id) => adjusted.has(id));
    // Keep the still-matching prefix of open scopes, close the rest, open the new tail.
    let shared = 0;
    while (shared < open.length && shared < chain.length && open[shared]!.id === chain[shared]) {
      shared += 1;
    }
    closeTo(shared, index);
    for (let depth = shared; depth < chain.length; depth += 1) {
      const id = chain[depth]!;
      open.push({ adjustments: adjusted.get(id)!, children: [], id, start: index });
    }
  });
  closeTo(0, items.length);
  return roots;
};
