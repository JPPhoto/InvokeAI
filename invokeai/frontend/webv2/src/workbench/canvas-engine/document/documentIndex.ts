import type {
  CanvasDocumentContractV3,
  CanvasGroupContract,
  CanvasLayerContract,
  CanvasLayerStackKind,
  CanvasNodeContract,
  CanvasStackForests,
} from '@workbench/canvas-engine/contracts';

import { LAYER_STACKS_TOP_FIRST } from '@workbench/canvas-engine/contracts';

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

const diagnostics = { indexBuilds: 0, indexDerivations: 0 };

export const getDocumentIndexBuildCount = (): number => diagnostics.indexBuilds;

/** Indexes derived from a previous one after a value edit, without walking the forests. */
export const getDocumentIndexDerivationCount = (): number => diagnostics.indexDerivations;

export const resetDocumentIndexBuildCount = (): void => {
  diagnostics.indexBuilds = 0;
  diagnostics.indexDerivations = 0;
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
  for (const stack of LAYER_STACKS_TOP_FIRST) {
    visit(stacks[stack], stack, null, [], true, false, false);
  }
  return { byId, leaves, maxDepth, nodes, stacks };
};

const flagsChanged = (previous: CanvasNodeContract, next: CanvasNodeContract): boolean =>
  isGroupNode(previous) &&
  isGroupNode(next) &&
  (previous.isEnabled !== next.isEnabled ||
    previous.isLocked !== next.isLocked ||
    (previous.isHidden === true) !== (next.isHidden === true));

/**
 * Registers the index of `nextStacks` as a derivation of `previousStacks`' index after a value edit
 * that rewrote exactly the nodes in `changed` (and, through structural sharing, their ancestors).
 * Structure is untouched, so every entry keeps its place and every unaffected entry, and the leaves
 * array when no leaf changed, keep their identity; only a group whose flags changed re-derives the
 * ancestor-effective flags of its subtree. Returns `null` when no previous index exists or the edit
 * was not a value edit, leaving the next lookup to build from scratch.
 */
export const deriveIndexForValueEdit = (
  previousStacks: CanvasStackForests,
  nextStacks: CanvasStackForests,
  changed: ReadonlyMap<string, CanvasNodeContract>
): CanvasDocumentIndex | null => {
  const existing = indexes.get(nextStacks);
  if (existing) {
    return existing;
  }
  const previous = indexes.get(previousStacks);
  if (!previous || previousStacks === nextStacks) {
    return null;
  }
  const replaced = new Map<string, CanvasNodeContract>();
  const reflagged = new Set<string>();
  for (const [id, node] of changed) {
    const entry = previous.byId.get(id);
    if (!entry || entry.node.id !== node.id || isGroupNode(entry.node) !== isGroupNode(node)) {
      return null;
    }
    replaced.set(id, node);
    if (flagsChanged(entry.node, node)) {
      reflagged.add(id);
    }
  }
  // Ancestors were rebuilt along each changed path; find their new objects from the new roots.
  for (const id of changed.keys()) {
    const entry = previous.byId.get(id)!;
    let siblings: readonly CanvasNodeContract[] = nextStacks[entry.stack];
    for (const ancestorId of entry.path) {
      const known = replaced.get(ancestorId);
      const ancestor = known ?? siblings.find((node) => node.id === ancestorId);
      if (!ancestor || !isGroupNode(ancestor)) {
        return null;
      }
      replaced.set(ancestorId, ancestor);
      siblings = ancestor.children;
    }
  }
  diagnostics.indexDerivations += 1;
  const nodeOf = (id: string): CanvasNodeContract => replaced.get(id) ?? previous.byId.get(id)!.node;
  let leafChanged = false;
  const nodes = previous.nodes.map((entry) => {
    const node = replaced.get(entry.node.id);
    const underReflagged = reflagged.size > 0 && entry.path.some((ancestorId) => reflagged.has(ancestorId));
    if (!node && !underReflagged) {
      return entry;
    }
    if (node && !isGroupNode(node)) {
      leafChanged = true;
    }
    const ancestors = underReflagged ? entry.path.map(nodeOf) : null;
    return {
      ...entry,
      ancestorsEnabled: ancestors ? ancestors.every((ancestor) => ancestor.isEnabled) : entry.ancestorsEnabled,
      ancestorsHidden: ancestors
        ? ancestors.some((ancestor) => isGroupNode(ancestor) && ancestor.isHidden === true)
        : entry.ancestorsHidden,
      ancestorsLocked: ancestors ? ancestors.some((ancestor) => ancestor.isLocked) : entry.ancestorsLocked,
      node: node ?? entry.node,
    };
  });
  const derived: CanvasDocumentIndex = {
    byId: new Map(nodes.map((entry) => [entry.node.id, entry])),
    leaves: leafChanged
      ? previous.leaves.map((leaf) => (replaced.get(leaf.id) as CanvasLayerContract | undefined) ?? leaf)
      : previous.leaves,
    maxDepth: previous.maxDepth,
    nodes,
    stacks: nextStacks,
  };
  indexes.set(nextStacks, derived);
  return derived;
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
