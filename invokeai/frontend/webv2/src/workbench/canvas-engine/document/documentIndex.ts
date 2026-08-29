import type {
  CanvasDocumentContractV3,
  CanvasGroupContract,
  CanvasLayerContract,
  CanvasLayerStackKind,
  CanvasNodeContract,
  CanvasStackForests,
} from '@workbench/canvas-engine/contracts';

import { isGroupNode } from './documentTree';

/** Document facts about one node's place in its forest. */
export interface CanvasNodeEntry {
  readonly node: CanvasNodeContract;
  readonly stack: CanvasLayerStackKind;
  readonly parentId: string | null;
  /** Ancestor ids, root first; `path.length` is the node's depth. */
  readonly path: readonly string[];
  readonly siblingIndex: number;
  /** Position among every node, stacks top first, each stack in preorder. */
  readonly order: number;
  /** Whether every ancestor is enabled, unlocked, or unhidden respectively. */
  readonly ancestorsEnabled: boolean;
  readonly ancestorsLocked: boolean;
  readonly ancestorsHidden: boolean;
}

/**
 * The per-forest index shared by the reducer, the mirror and the document model. It is keyed on
 * the `stacks` object, which the reducer preserves across selection, bbox and geometry-only edits.
 */
export interface CanvasDocumentIndex {
  readonly stacks: CanvasStackForests;
  readonly byId: ReadonlyMap<string, CanvasNodeEntry>;
  /** Every node, stacks top first, each in preorder. */
  readonly nodes: readonly CanvasNodeEntry[];
  /** Every leaf, in the same order. */
  readonly leaves: readonly CanvasLayerContract[];
  readonly maxDepth: number;
}

const STACKS_TOP_FIRST: readonly CanvasLayerStackKind[] = ['inpaint_mask', 'regional_guidance', 'control', 'raster'];

const diagnostics = { indexBuilds: 0 };

export const getDocumentIndexBuildCount = (): number => diagnostics.indexBuilds;

export const resetDocumentIndexBuildCount = (): void => {
  diagnostics.indexBuilds = 0;
};

type DocumentView = Pick<CanvasDocumentContractV3, 'stacks'> | null | undefined;

const EMPTY_LEAVES: readonly CanvasLayerContract[] = [];

const indexes = new WeakMap<CanvasStackForests, CanvasDocumentIndex>();

const build = (stacks: CanvasStackForests): CanvasDocumentIndex => {
  diagnostics.indexBuilds += 1;
  const byId = new Map<string, CanvasNodeEntry>();
  const nodes: CanvasNodeEntry[] = [];
  const leaves: CanvasLayerContract[] = [];
  let maxDepth = 0;
  const visit = (
    children: readonly CanvasNodeContract[],
    stack: CanvasLayerStackKind,
    parent: CanvasGroupContract | null,
    path: readonly string[],
    ancestorsEnabled: boolean,
    ancestorsLocked: boolean,
    ancestorsHidden: boolean
  ): void => {
    maxDepth = Math.max(maxDepth, path.length);
    children.forEach((node, siblingIndex) => {
      const entry: CanvasNodeEntry = {
        ancestorsEnabled,
        ancestorsHidden,
        ancestorsLocked,
        node,
        order: nodes.length,
        parentId: parent?.id ?? null,
        path,
        siblingIndex,
        stack,
      };
      byId.set(node.id, entry);
      nodes.push(entry);
      if (isGroupNode(node)) {
        visit(
          node.children,
          stack,
          node,
          [...path, node.id],
          ancestorsEnabled && node.isEnabled,
          ancestorsLocked || node.isLocked,
          ancestorsHidden || node.isHidden === true
        );
      } else {
        leaves.push(node);
      }
    });
  };
  for (const stack of STACKS_TOP_FIRST) {
    visit(stacks[stack], stack, null, [], true, false, false);
  }
  return { byId, leaves, maxDepth, nodes, stacks };
};

export const indexStacks = (stacks: CanvasStackForests): CanvasDocumentIndex => {
  const existing = indexes.get(stacks);
  if (existing) {
    return existing;
  }
  const built = build(stacks);
  indexes.set(stacks, built);
  return built;
};

export const getDocumentIndex = (document: Pick<CanvasDocumentContractV3, 'stacks'>): CanvasDocumentIndex =>
  indexStacks(document.stacks);

/** The document's leaves, stacks top first, each in preorder; the same array while `stacks` is unchanged. */
export const getDocumentLeaves = (document: DocumentView): readonly CanvasLayerContract[] =>
  document ? indexStacks(document.stacks).leaves : EMPTY_LEAVES;

export const getDocumentNode = (document: DocumentView, id: string | null | undefined): CanvasNodeContract | null =>
  document && id ? (indexStacks(document.stacks).byId.get(id)?.node ?? null) : null;

/** The leaf with `id`, or `null` when absent, a group, or there is no document. */
export const getDocumentLayer = (document: DocumentView, id: string | null | undefined): CanvasLayerContract | null => {
  const node = getDocumentNode(document, id);
  return node && !isGroupNode(node) ? node : null;
};

export const hasDocumentNode = (document: DocumentView, id: string): boolean =>
  !!document && indexStacks(document.stacks).byId.has(id);

/** True only when a document exists and holds no node with `id`. */
export const isNodeAbsent = (document: DocumentView, id: string): boolean =>
  !!document && !indexStacks(document.stacks).byId.has(id);

/** Whether `ancestorId` is `id` itself or one of its ancestors. */
export const isSelfOrAncestor = (index: CanvasDocumentIndex, id: string, ancestorId: string): boolean =>
  id === ancestorId || (index.byId.get(id)?.path.includes(ancestorId) ?? false);

/** Drops every id whose ancestor is also listed, keeping document order. */
export const outermostNodes = (index: CanvasDocumentIndex, ids: Iterable<string>): CanvasNodeEntry[] => {
  const selected = new Set(ids);
  const outer: CanvasNodeEntry[] = [];
  for (const entry of index.nodes) {
    if (selected.has(entry.node.id) && !entry.path.some((ancestor) => selected.has(ancestor))) {
      outer.push(entry);
    }
  }
  return outer;
};

/** The child list `parentId` names, read through the index; `null` when the parent is not a group of `stack`. */
export const childrenAt = (
  index: CanvasDocumentIndex,
  stack: CanvasLayerStackKind,
  parentId: string | null
): readonly CanvasNodeContract[] | null => {
  if (parentId === null) {
    return index.stacks[stack];
  }
  const parent = index.byId.get(parentId);
  return parent && parent.stack === stack && isGroupNode(parent.node) ? parent.node.children : null;
};
