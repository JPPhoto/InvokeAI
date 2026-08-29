import type { LayerStackKind } from '@workbench/canvas-engine/api';

import { CANVAS_MAX_NODE_DEPTH } from '@workbench/canvas-engine/api';

import type { LayerTreeRow } from './layerTreeRows';

/** Where a dragged block lands, expressed as the model's `reparent` target. */
export interface LayerDropTarget {
  readonly stack: LayerStackKind;
  readonly parentId: string | null;
  /** The sibling the block lands above, or `null` for the bottom of `parentId`. */
  readonly beforeId: string | null;
  /** The depth the preview draws the block at. */
  readonly depth: number;
  /** Ids that move, outermost only, in document order. */
  readonly ids: readonly string[];
}

export interface LayerDropInput {
  /** The stack's rendered rows, top first. */
  readonly rows: readonly LayerTreeRow[];
  /** Every selected id that drags along; descendants of another dragged id are folded in. */
  readonly activeIds: readonly string[];
  readonly overId: string;
  /** Whether the pointer sits in the upper or lower half of the row it is over. */
  readonly edge: 'above' | 'below';
  /** How many indent steps the pointer has moved horizontally since the drag began. */
  readonly depthOffset: number;
}

/** The descendants of a rendered row are the following rows with a greater depth. */
const subtreeEnd = (rows: readonly LayerTreeRow[], start: number): number => {
  const depth = rows[start]!.depth;
  let end = start + 1;
  while (end < rows.length && rows[end]!.depth > depth) {
    end += 1;
  }
  return end;
};

/**
 * Projects a drag onto the sortable-tree target it describes: the dragged block leaves the list,
 * the pointer's vertical position picks the gap, and its horizontal offset picks the depth
 * between the shallowest and deepest parent that gap allows. Returns `null` when nothing valid
 * is under the pointer, when the pointer is over the block itself, or when the move would exceed
 * the depth limit. Locks, cycles across stacks, and other document refusals stay with the model.
 */
export const projectLayerDrop = (input: LayerDropInput): LayerDropTarget | null => {
  const { rows } = input;
  const selected = new Set(input.activeIds);
  const outer = rows.filter(
    (row, index) =>
      selected.has(row.id) &&
      !rows.slice(0, index).some((candidate) => selected.has(candidate.id) && isAncestorRow(rows, candidate, row))
  );
  if (outer.length === 0) {
    return null;
  }
  const moving = new Set<string>();
  let deepestSubtree = 0;
  for (const row of outer) {
    const start = rows.indexOf(row);
    const end = subtreeEnd(rows, start);
    for (let index = start; index < end; index += 1) {
      moving.add(rows[index]!.id);
    }
    deepestSubtree = Math.max(deepestSubtree, row.subtreeDepth);
  }
  if (moving.has(input.overId)) {
    return null;
  }
  const remaining = rows.filter((row) => !moving.has(row.id));
  const overIndex = remaining.findIndex((row) => row.id === input.overId);
  if (overIndex < 0) {
    return null;
  }
  const insertAt = input.edge === 'above' ? overIndex : overIndex + 1;
  const previous = remaining[insertAt - 1];
  const next = remaining[insertAt];
  const maxDepth = Math.min(
    previous ? previous.depth + (previous.kind === 'group' && previous.expanded ? 1 : 0) : 0,
    CANVAS_MAX_NODE_DEPTH - deepestSubtree
  );
  const minDepth = next ? next.depth : 0;
  if (maxDepth < minDepth) {
    return null;
  }
  const depth = Math.max(minDepth, Math.min(maxDepth, outer[0]!.depth + input.depthOffset));
  let parentId: string | null = null;
  if (depth > 0 && previous) {
    if (previous.depth < depth) {
      parentId = previous.id;
    } else {
      for (let index = insertAt - 1; index >= 0; index -= 1) {
        const candidate = remaining[index]!;
        if (candidate.depth === depth - 1) {
          parentId = candidate.id;
          break;
        }
      }
    }
  }
  const beforeId = next && next.parentId === parentId && next.depth === depth ? next.id : null;
  return { beforeId, depth, ids: outer.map((row) => row.id), parentId, stack: rows[0]!.stack };
};

const isAncestorRow = (rows: readonly LayerTreeRow[], ancestor: LayerTreeRow, row: LayerTreeRow): boolean => {
  const start = rows.indexOf(ancestor);
  const index = rows.indexOf(row);
  return ancestor.kind === 'group' && index > start && index < subtreeEnd(rows, start);
};
