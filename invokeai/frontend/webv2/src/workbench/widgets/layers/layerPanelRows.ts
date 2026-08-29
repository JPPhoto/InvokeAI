import type { LayerStackKind } from '@workbench/canvas-engine/api';
import type { LayerPanelDensity } from '@workbench/layerPanelState';

import { LAYER_STACKS_TOP_FIRST } from '@workbench/canvas-engine/api';

import type { LayerStackRows, LayerStackRowsByKind, LayerTreeRow } from './layerTreeRows';

/** Fixed row heights per density: the virtualizer never measures. */
export const LAYER_ROW_HEIGHT_PX: Record<LayerPanelDensity, number> = { comfortable: 40, compact: 28, large: 56 };
export const LAYER_HEADER_HEIGHT_PX = 28;
/** Horizontal offset per nesting level, in CSS pixels; the drag projection uses the same step. */
export const LAYER_TREE_INDENT_PX = 16;
/** Above this many nodes the panel drops thumbnails and drag reordering to stay deterministic. */
export const LAYER_PANEL_DEGRADE_THRESHOLD = 2_000;

export type PanelRow =
  | { readonly kind: 'header'; readonly key: string; readonly stack: LayerStackRows; readonly collapsed: boolean }
  | { readonly kind: 'node'; readonly key: string; readonly stack: LayerStackKind; readonly row: LayerTreeRow };

/**
 * The one flat list the panel virtualizes: a header per non-empty stack followed by its rendered
 * rows unless the stack is collapsed. `forceOpen` keeps a collapsed stack open while something
 * inside it must stay reachable, like a pending properties request.
 */
export const flattenPanelRows = (
  stacks: LayerStackRowsByKind,
  collapsedStacks: readonly LayerStackKind[],
  forceOpen: (stack: LayerStackKind) => boolean
): PanelRow[] => {
  const rows: PanelRow[] = [];
  for (const kind of LAYER_STACKS_TOP_FIRST) {
    const stack = stacks[kind];
    if (stack.nodeIds.length === 0) {
      continue;
    }
    const collapsed = collapsedStacks.includes(kind) && !forceOpen(kind);
    rows.push({ collapsed, key: `header:${kind}`, kind: 'header', stack });
    if (!collapsed) {
      for (const row of stack.rows) {
        rows.push({ key: row.id, kind: 'node', row, stack: kind });
      }
    }
  }
  return rows;
};

export const panelRowHeight = (row: PanelRow, density: LayerPanelDensity): number =>
  row.kind === 'header' ? LAYER_HEADER_HEIGHT_PX : LAYER_ROW_HEIGHT_PX[density];

export type TreeNavigationKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End' | 'ArrowLeft' | 'ArrowRight';

export type TreeNavigation = { readonly focus: string } | { readonly expand: string; readonly expanded: boolean };

/**
 * The WAI-ARIA tree keyboard model over the flat list: vertical keys walk rendered node rows,
 * Home/End jump, Right opens a group or enters it, Left closes a group or climbs to the parent.
 */
type NodePanelRow = Extract<PanelRow, { kind: 'node' }>;

const nodeRowsCache = new WeakMap<readonly PanelRow[], { rows: NodePanelRow[]; positions: Map<string, number> }>();

/** The node rows of a list and their positions, computed once per list identity. */
const nodeRowsOf = (rows: readonly PanelRow[]) => {
  let cached = nodeRowsCache.get(rows);
  if (!cached) {
    const nodeRows = rows.filter((row): row is NodePanelRow => row.kind === 'node');
    cached = { positions: new Map(nodeRows.map((row, index) => [row.row.id, index])), rows: nodeRows };
    nodeRowsCache.set(rows, cached);
  }
  return cached;
};

export const navigateTree = (
  rows: readonly PanelRow[],
  currentId: string,
  key: TreeNavigationKey
): TreeNavigation | null => {
  const { positions, rows: nodeRows } = nodeRowsOf(rows);
  const position = positions.get(currentId) ?? -1;
  if (position < 0) {
    return nodeRows[0] ? { focus: nodeRows[0].row.id } : null;
  }
  const current = nodeRows[position]!.row;
  switch (key) {
    case 'ArrowDown':
      return nodeRows[position + 1] ? { focus: nodeRows[position + 1]!.row.id } : null;
    case 'ArrowUp':
      return nodeRows[position - 1] ? { focus: nodeRows[position - 1]!.row.id } : null;
    case 'Home':
      return { focus: nodeRows[0]!.row.id };
    case 'End':
      return { focus: nodeRows[nodeRows.length - 1]!.row.id };
    case 'ArrowRight': {
      if (current.vm.kind !== 'group' || current.vm.childCount === 0) {
        return null;
      }
      if (!current.expanded) {
        return { expand: current.id, expanded: true };
      }
      const child = nodeRows[position + 1];
      return child && child.row.vm.parentId === current.id ? { focus: child.row.id } : null;
    }
    case 'ArrowLeft':
      if (current.vm.kind === 'group' && current.expanded) {
        return { expand: current.id, expanded: false };
      }
      return current.vm.parentId ? { focus: current.vm.parentId } : null;
  }
};

export const isTreeNavigationKey = (key: string): key is TreeNavigationKey =>
  key === 'ArrowDown' ||
  key === 'ArrowUp' ||
  key === 'Home' ||
  key === 'End' ||
  key === 'ArrowLeft' ||
  key === 'ArrowRight';
