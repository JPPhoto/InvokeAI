import type {
  CanvasDocumentContractV3,
  CanvasNodeContract,
  CanvasNodeEntry,
  LayerStackKind,
} from '@workbench/canvas-engine/api';

import {
  collectSubtreeLeaves,
  getDocumentIndex,
  isGroupNode,
  isNodeHidden,
  subtreeDepth,
} from '@workbench/canvas-engine/api';

/** One Layers-panel row: a node plus the tree and effective facts the row renders. */
export interface LayerTreeRow {
  readonly id: string;
  readonly kind: 'group' | 'leaf';
  readonly stack: LayerStackKind;
  readonly node: CanvasNodeContract;
  readonly parentId: string | null;
  readonly depth: number;
  /** Groups only: whether the row shows its children. */
  readonly expanded: boolean;
  readonly childCount: number;
  readonly leafCount: number;
  /** Levels below this node, rendered or not; 0 for a leaf or an empty group. */
  readonly subtreeDepth: number;
  /** The node and every ancestor are enabled. */
  readonly contributionEnabled: boolean;
  /** The node or an ancestor is locked. */
  readonly effectiveLocked: boolean;
  /** The node or an ancestor is display-hidden. */
  readonly documentHidden: boolean;
  /** An ancestor alone disables, locks, or hides this node. */
  readonly gatedByAncestor: boolean;
}

export interface LayerStackRows {
  readonly stack: LayerStackKind;
  /** Rows the panel renders, top first; children of collapsed groups are absent. */
  readonly rows: readonly LayerTreeRow[];
  /** Every node id in the stack, top first, whether rendered or not. */
  readonly nodeIds: readonly string[];
  readonly leafCount: number;
}

const rowsByNode = new WeakMap<CanvasNodeContract, LayerTreeRow>();

const isRowCurrent = (row: LayerTreeRow, entry: CanvasNodeEntry, expanded: boolean): boolean =>
  row.node === entry.node &&
  row.parentId === entry.parentId &&
  row.depth === entry.path.length &&
  row.expanded === expanded &&
  row.contributionEnabled === (entry.ancestorsEnabled && row.node.isEnabled) &&
  row.effectiveLocked === (entry.ancestorsLocked || entry.node.isLocked) &&
  row.documentHidden === (entry.ancestorsHidden || isNodeHidden(entry.node));

const rowFor = (entry: CanvasNodeEntry, expanded: boolean): LayerTreeRow => {
  const cached = rowsByNode.get(entry.node);
  if (cached && isRowCurrent(cached, entry, expanded)) {
    return cached;
  }
  const { node } = entry;
  const group = isGroupNode(node);
  const row: LayerTreeRow = {
    childCount: group ? node.children.length : 0,
    contributionEnabled: entry.ancestorsEnabled && node.isEnabled,
    depth: entry.path.length,
    documentHidden: entry.ancestorsHidden || isNodeHidden(node),
    effectiveLocked: entry.ancestorsLocked || node.isLocked,
    expanded: group && expanded,
    gatedByAncestor: !entry.ancestorsEnabled || entry.ancestorsLocked || entry.ancestorsHidden,
    id: node.id,
    kind: group ? 'group' : 'leaf',
    leafCount: group ? collectSubtreeLeaves(node).length : 1,
    node,
    parentId: entry.parentId,
    stack: entry.stack,
    subtreeDepth: group ? Math.max(1, subtreeDepth(node)) : 0,
  };
  rowsByNode.set(node, row);
  return row;
};

/**
 * The rows of every stack for a document and the set of expanded groups. Row objects keep their
 * identity while their node, place, effective state, and expansion are unchanged, so memoized row
 * components skip unaffected rows.
 */
export const buildLayerStackRows = (
  document: CanvasDocumentContractV3,
  expandedGroupIds: ReadonlySet<string>
): Record<LayerStackKind, LayerStackRows> => {
  const index = getDocumentIndex(document);
  const result: Record<LayerStackKind, { rows: LayerTreeRow[]; nodeIds: string[]; leafCount: number }> = {
    control: { leafCount: 0, nodeIds: [], rows: [] },
    inpaint_mask: { leafCount: 0, nodeIds: [], rows: [] },
    raster: { leafCount: 0, nodeIds: [], rows: [] },
    regional_guidance: { leafCount: 0, nodeIds: [], rows: [] },
  };
  const collapsed = new Set<string>();
  for (const entry of index.nodes) {
    const target = result[entry.stack];
    target.nodeIds.push(entry.node.id);
    if (!isGroupNode(entry.node)) {
      target.leafCount += 1;
    }
    if (entry.path.some((ancestor) => collapsed.has(ancestor))) {
      if (isGroupNode(entry.node) && !expandedGroupIds.has(entry.node.id)) {
        collapsed.add(entry.node.id);
      }
      continue;
    }
    const expanded = isGroupNode(entry.node) && expandedGroupIds.has(entry.node.id);
    if (isGroupNode(entry.node) && !expanded) {
      collapsed.add(entry.node.id);
    }
    target.rows.push(rowFor(entry, expanded));
  }
  return {
    control: { stack: 'control', ...result.control },
    inpaint_mask: { stack: 'inpaint_mask', ...result.inpaint_mask },
    raster: { stack: 'raster', ...result.raster },
    regional_guidance: { stack: 'regional_guidance', ...result.regional_guidance },
  };
};
