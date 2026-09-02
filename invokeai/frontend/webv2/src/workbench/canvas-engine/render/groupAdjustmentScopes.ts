/**
 * Nested contiguous [start, end) scopes over a flat drawn list, one per
 * adjusted group; both renderers consume the same shape. Relies on preorder
 * (or its reversal) keeping every subtree contiguous.
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

/** The raster-stack groups whose stacks contribute (non-identity; disabled groups never draw). */
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

/** Plans nested scopes over `items` (ancestor chains outermost-first); outermost scopes in list order. */
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
