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
  | {
      readonly kind: 'header';
      readonly key: string;
      readonly stack: LayerStackRows;
      readonly collapsed: boolean;
      /** The header's place among the non-empty stacks, for `aria-posinset` / `aria-setsize`. */
      readonly posInSet: number;
      readonly setSize: number;
    }
  | { readonly kind: 'node'; readonly key: string; readonly stack: LayerStackKind; readonly row: LayerTreeRow };

export const headerKey = (stack: LayerStackKind): string => `header:${stack}`;

export const isHeaderKey = (key: string): boolean => key.startsWith('header:');

export const stackOfHeaderKey = (key: string): LayerStackKind => key.slice('header:'.length) as LayerStackKind;

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
  const present = LAYER_STACKS_TOP_FIRST.filter((kind) => stacks[kind].nodeIds.length > 0);
  for (const kind of present) {
    const stack = stacks[kind];
    const collapsed = collapsedStacks.includes(kind) && !forceOpen(kind);
    rows.push({
      collapsed,
      key: headerKey(kind),
      kind: 'header',
      posInSet: present.indexOf(kind) + 1,
      setSize: present.length,
      stack,
    });
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

export type TreeNavigation =
  | { readonly focus: string }
  | { readonly expand: string; readonly expanded: boolean }
  | { readonly collapseStack: LayerStackKind; readonly collapsed: boolean };

const positionsCache = new WeakMap<readonly PanelRow[], Map<string, number>>();

const positionsOf = (rows: readonly PanelRow[]): Map<string, number> => {
  let cached = positionsCache.get(rows);
  if (!cached) {
    cached = new Map(rows.map((row, index) => [row.key, index]));
    positionsCache.set(rows, cached);
  }
  return cached;
};

/**
 * The WAI-ARIA tree keyboard model over the flat list, headers included: vertical keys walk every
 * rendered item, Home/End jump, Right opens a stack or group or enters it, Left closes one or
 * climbs to the parent (a root node's parent is its stack header).
 */
export const navigateTree = (
  rows: readonly PanelRow[],
  currentKey: string,
  key: TreeNavigationKey
): TreeNavigation | null => {
  const position = positionsOf(rows).get(currentKey) ?? -1;
  if (position < 0) {
    return rows[0] ? { focus: rows[0].key } : null;
  }
  const current = rows[position]!;
  switch (key) {
    case 'ArrowDown':
      return rows[position + 1] ? { focus: rows[position + 1]!.key } : null;
    case 'ArrowUp':
      return rows[position - 1] ? { focus: rows[position - 1]!.key } : null;
    case 'Home':
      return { focus: rows[0]!.key };
    case 'End':
      return { focus: rows[rows.length - 1]!.key };
    case 'ArrowRight': {
      if (current.kind === 'header') {
        if (current.collapsed) {
          return { collapsed: false, collapseStack: current.stack.stack };
        }
        const first = rows[position + 1];
        return first && first.kind === 'node' ? { focus: first.key } : null;
      }
      const { row } = current;
      if (row.vm.kind !== 'group' || row.vm.childCount === 0) {
        return null;
      }
      if (!row.expanded) {
        return { expand: row.id, expanded: true };
      }
      const child = rows[position + 1];
      return child && child.kind === 'node' && child.row.vm.parentId === row.id ? { focus: child.key } : null;
    }
    case 'ArrowLeft': {
      if (current.kind === 'header') {
        return current.collapsed ? null : { collapsed: true, collapseStack: current.stack.stack };
      }
      const { row } = current;
      if (row.vm.kind === 'group' && row.expanded) {
        return { expand: row.id, expanded: false };
      }
      return { focus: row.vm.parentId ?? headerKey(row.vm.stack) };
    }
  }
};

export const isTreeNavigationKey = (key: string): key is TreeNavigationKey =>
  key === 'ArrowDown' ||
  key === 'ArrowUp' ||
  key === 'Home' ||
  key === 'End' ||
  key === 'ArrowLeft' ||
  key === 'ArrowRight';
