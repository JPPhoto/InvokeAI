import type { CanvasDocumentContractV2, CanvasLayerContract } from '@workbench/canvas-engine/contracts';
import type { FlatLayerInsertion } from '@workbench/canvas-engine/document/insertionAnchors';
import type { LayerStackKind } from '@workbench/canvas-engine/document/layerStacks';
import type {
  CanvasLayerBasePatch,
  CanvasLayerConfigPatch,
  CanvasProjectMutation,
} from '@workbench/canvas-engine/mutationContracts';

import {
  captureInsertionAnchor,
  captureRestoreAnchor,
  insertLayersAtAnchor,
} from '@workbench/canvas-engine/document/insertionAnchors';
import {
  isHideableLayer,
  isLayerContributing,
  isLayerHidden,
  isPixelBackedLayer,
} from '@workbench/canvas-engine/document/layerEligibility';
import {
  getStackOrder,
  LAYER_STACKS_TOP_FIRST,
  layerStackOf,
  moveLayersWithinStacks,
  reorderLayerStack,
} from '@workbench/canvas-engine/document/layerStacks';
import { repairSelectedLayerId } from '@workbench/canvas-engine/document/selectionRepair';

import type {
  FlatDocumentCommand,
  FlatDocumentRefusal,
  MergeDownEligibility,
  PreparedFlatEdit,
  PrepareFlatEditResult,
} from './flatDocumentCommands';
import type { FlatEditPostcondition } from './postconditions';
import type { SemanticLeafV2 } from './semanticLeaf';

import { isConfigApplied, isPatchApplied, sameValue } from './postconditions';
import { compileSemanticLeaf } from './semanticLeaf';

export interface FlatDocumentModelContext {
  readonly projectId: string;
  readonly editRevision: number;
}

/**
 * The pure document seam over a v2 canvas document: lookup, stack order, semantic leaves and
 * prepared flat edits, with no knowledge of the engine, the screen or the panel. Indexes are built
 * once per layer-array identity and leaves keep their identity while their immutable layer object is
 * unchanged. Ordering belongs to the returned sequence rather than being duplicated into each leaf.
 */
export interface FlatCanvasDocumentModel {
  readonly document: CanvasDocumentContractV2;
  getLayer(id: string): CanvasLayerContract | null;
  getStack(kind: LayerStackKind): readonly CanvasLayerContract[];
  compileLeaves(): readonly SemanticLeafV2[];
  canMergeDown(upperId: string): MergeDownEligibility;
  prepare(command: FlatDocumentCommand): PrepareFlatEditResult;
}

interface LayerIndexEntry {
  readonly layer: CanvasLayerContract;
  readonly index: number;
  readonly stack: LayerStackKind;
  readonly stackIndex: number;
}

interface DocumentIndex {
  readonly byId: ReadonlyMap<string, LayerIndexEntry>;
  readonly stacks: Readonly<Record<LayerStackKind, readonly CanvasLayerContract[]>>;
  leaves: readonly SemanticLeafV2[] | null;
}

export interface FlatDocumentModelDiagnostics {
  readonly indexBuilds: number;
  readonly leafCompilations: number;
  readonly leavesCompiled: number;
}

/** Internal deterministic instrumentation; production logic never reads it. */
const diagnostics = { indexBuilds: 0, leafCompilations: 0, leavesCompiled: 0 };

/** Immutable snapshot for deterministic budget tests and diagnostics. */
export const getFlatDocumentModelDiagnostics = (): FlatDocumentModelDiagnostics => ({ ...diagnostics });

/** Test seam that resets counters without exposing mutable production state. */
export const resetFlatDocumentModelDiagnostics = (): void => {
  diagnostics.indexBuilds = 0;
  diagnostics.leafCompilations = 0;
  diagnostics.leavesCompiled = 0;
};

type LayerArray = CanvasDocumentContractV2['layers'];

const indexes = new WeakMap<LayerArray, DocumentIndex>();
const leavesByLayer = new WeakMap<CanvasLayerContract, SemanticLeafV2>();

const buildIndex = (layers: LayerArray): DocumentIndex => {
  diagnostics.indexBuilds += 1;
  const byId = new Map<string, LayerIndexEntry>();
  const stacks: Record<LayerStackKind, CanvasLayerContract[]> = {
    control: [],
    inpaint_mask: [],
    raster: [],
    regional_guidance: [],
  };
  layers.forEach((layer, index) => {
    const stack = layerStackOf(layer);
    byId.set(layer.id, { index, layer, stack, stackIndex: stacks[stack].length });
    stacks[stack].push(layer);
  });
  return { byId, leaves: null, stacks };
};

/** Indexes are keyed on the layer array, so a selection-only document change reuses them. */
const indexOf = (document: CanvasDocumentContractV2): DocumentIndex => {
  const existing = indexes.get(document.layers);
  if (existing) {
    return existing;
  }
  const built = buildIndex(document.layers);
  indexes.set(document.layers, built);
  return built;
};

const compileLeaves = (document: CanvasDocumentContractV2, index: DocumentIndex): readonly SemanticLeafV2[] => {
  if (index.leaves) {
    return index.leaves;
  }
  diagnostics.leafCompilations += 1;
  const leaves = document.layers.map((layer) => {
    const cached = leavesByLayer.get(layer);
    if (cached) {
      return cached;
    }
    diagnostics.leavesCompiled += 1;
    const leaf = compileSemanticLeaf(layer);
    leavesByLayer.set(layer, leaf);
    return leaf;
  });
  index.leaves = leaves;
  return leaves;
};

const missing = (ids: readonly string[]): FlatDocumentRefusal => ({ ids, status: 'missing' });

/** The layer with `id`, through the per-document index. */
export const lookupDocumentLayer = (document: CanvasDocumentContractV2, id: string): CanvasLayerContract | null =>
  indexOf(document).byId.get(id)?.layer ?? null;

/** The document's semantic leaves in flat order. Immutable layer identity provides cross-edit reuse. */
export const compileDocumentLeaves = (document: CanvasDocumentContractV2): readonly SemanticLeafV2[] =>
  compileLeaves(document, indexOf(document));

/** The leaf for `id`, or `null` when the document has no such layer. */
export const lookupDocumentLeaf = (document: CanvasDocumentContractV2, id: string): SemanticLeafV2 | null => {
  const entry = indexOf(document).byId.get(id);
  return entry ? (compileDocumentLeaves(document)[entry.index] ?? null) : null;
};

/** The layer directly below `id` in flat order, whatever its stack; `null` at the bottom or when absent. */
export const lookupLayerBelow = (document: CanvasDocumentContractV2, id: string): CanvasLayerContract | null => {
  const entry = indexOf(document).byId.get(id);
  return entry ? (document.layers[entry.index + 1] ?? null) : null;
};

/** Merge-down joins a raster layer with the layer directly below it in flat order, mirroring the reducer. */
export const mergeDownEligibility = (document: CanvasDocumentContractV2, upperId: string): MergeDownEligibility => {
  const upper = indexOf(document).byId.get(upperId);
  if (!upper) {
    return missing([upperId]);
  }
  if (upper.stack !== 'raster') {
    return { actual: upper.stack, expected: ['raster'], status: 'wrong-type' };
  }
  const lower = lookupLayerBelow(document, upperId);
  if (!lower) {
    return { reason: 'no-layer-below', status: 'invalid-target', targetId: upperId };
  }
  const unmergeable = [upper.layer, lower].find((layer) => layer.type !== 'raster' || !isPixelBackedLayer(layer));
  if (unmergeable) {
    return { reason: 'not-mergeable', status: 'invalid-target', targetId: unmergeable.id };
  }
  const locked = [upper.layer, lower].filter((layer) => layer.isLocked).map((layer) => layer.id);
  if (locked.length > 0) {
    return { ids: locked, status: 'locked' };
  }
  const disabled = [upper.layer, lower].find((layer) => !isLayerContributing(layer));
  if (disabled) {
    return { reason: 'not-mergeable', status: 'invalid-target', targetId: disabled.id };
  }
  return { lowerId: lower.id, status: 'eligible', upperId };
};

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/**
 * Whether two patches name the same fields, descending only into the partial containers listed in
 * `containers` as dotted paths; every other value is compared as a whole.
 */
const sameKeys = (
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  containers: readonly string[],
  path = ''
): boolean => {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, position) => key === rightKeys[position]) &&
    leftKeys.every((key) => {
      const keyPath = path ? `${path}.${key}` : key;
      if (!containers.includes(keyPath)) {
        return true;
      }
      const a = left[key];
      const b = right[key];
      return typeof a === 'object' && a !== null && typeof b === 'object' && b !== null
        ? sameKeys(a as Record<string, unknown>, b as Record<string, unknown>, containers, keyPath)
        : a === undefined && b === undefined;
    })
  );
};

const PATCH_CONTAINERS = ['transform'] as const;
const CONFIG_CONTAINERS = ['adapter', 'mask', 'mask.fill'] as const;

const stacksTopFirst = (stacks: readonly LayerStackKind[]): LayerStackKind[] =>
  LAYER_STACKS_TOP_FIRST.filter((stack) => stacks.includes(stack));

const stackOrders = (
  layers: readonly CanvasLayerContract[],
  stacks: readonly LayerStackKind[]
): FlatEditPostcondition[] =>
  stacks.map((stack) => ({ kind: 'stack-order', orderedIds: getStackOrder(layers, stack).orderedIds, stack }));

const patchInverse = (layer: CanvasLayerContract, patch: CanvasLayerBasePatch): CanvasLayerBasePatch => {
  const inverse: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as (keyof CanvasLayerBasePatch)[]) {
    if (key === 'transform') {
      const transform: Record<string, number> = {};
      for (const axis of Object.keys(patch.transform ?? {}) as (keyof CanvasLayerContract['transform'])[]) {
        transform[axis] = layer.transform[axis];
      }
      inverse.transform = transform;
    } else {
      inverse[key] = layer[key];
    }
  }
  return inverse as CanvasLayerBasePatch;
};

export const createFlatDocumentModel = (
  document: CanvasDocumentContractV2,
  context: FlatDocumentModelContext
): FlatCanvasDocumentModel => {
  const index = indexOf(document);
  const { layers, selectedLayerId } = document;

  const lookup = (ids: readonly string[]): { entries: LayerIndexEntry[] } | FlatDocumentRefusal => {
    const absent = ids.filter((id) => !index.byId.has(id));
    return absent.length > 0 ? missing(absent) : { entries: ids.map((id) => index.byId.get(id)!) };
  };

  const prepared = (
    forward: CanvasProjectMutation,
    inverse: CanvasProjectMutation,
    detail: Omit<
      PreparedFlatEdit,
      'forward' | 'inverse' | 'projectId' | 'expectedRevision' | 'selectionBefore' | 'rasterWork'
    >
  ): PrepareFlatEditResult => ({
    edit: {
      ...detail,
      expectedRevision: context.editRevision,
      forward,
      inverse,
      projectId: context.projectId,
      rasterWork: null,
      selectionBefore: selectedLayerId,
    },
    status: 'prepared',
  });

  const prepareInsert = (command: Extract<FlatDocumentCommand, { type: 'insert' }>): PrepareFlatEditResult => {
    if (command.layers.length === 0) {
      return { operation: 'insert nothing', status: 'unsupported' };
    }
    const ids = command.layers.map((layer) => layer.id);
    const clash = ids.find((id, at) => index.byId.has(id) || ids.indexOf(id) !== at);
    if (clash !== undefined) {
      return { reason: 'id-exists', status: 'invalid-target', targetId: clash };
    }
    const selectionAfter = command.selectId === undefined ? ids.at(-1)! : command.selectId;
    if (selectionAfter !== null && !ids.includes(selectionAfter) && !index.byId.has(selectionAfter)) {
      return missing([selectionAfter]);
    }
    const touchedStacks = stacksTopFirst(command.layers.map(layerStackOf));
    const add: FlatLayerInsertion[] = touchedStacks.map((stack) => ({
      anchor: captureInsertionAnchor(layers, {
        aboveId: command.aboveId,
        editRevision: context.editRevision,
        projectId: context.projectId,
        stack,
      }),
      layers: command.layers.filter((layer) => layerStackOf(layer) === stack),
    }));
    const expected = add.reduce(
      (next, insertion) => insertLayersAtAnchor(next, insertion.anchor, insertion.layers),
      layers
    );
    return prepared(
      { add, enabledUpdates: [], selectedLayerId: selectionAfter, type: 'applyCanvasLayerStackMutation' },
      { enabledUpdates: [], removeIds: ids, selectedLayerId, type: 'applyCanvasLayerStackMutation' },
      {
        history: 'record',
        postconditions: [...stackOrders(expected, touchedStacks), { id: selectionAfter, kind: 'selection' }],
        selectionAfter,
        touchedIds: ids,
        touchedStacks,
      }
    );
  };

  const prepareRemove = (command: Extract<FlatDocumentCommand, { type: 'remove' }>): PrepareFlatEditResult => {
    const ids = unique(command.ids);
    if (ids.length === 0) {
      return { operation: 'remove nothing', status: 'unsupported' };
    }
    const found = lookup(ids);
    if ('status' in found) {
      return found;
    }
    const locked = found.entries.filter((entry) => entry.layer.isLocked).map((entry) => entry.layer.id);
    if (locked.length > 0) {
      return { ids: locked, status: 'locked' };
    }
    const removed = new Set(ids);
    const remaining = layers.filter((layer) => !removed.has(layer.id));
    const selectionAfter = repairSelectedLayerId(remaining, selectedLayerId, layers);
    const touchedStacks = stacksTopFirst(found.entries.map((entry) => entry.stack));
    const add: FlatLayerInsertion[] = layers
      .filter((layer) => removed.has(layer.id))
      .map((layer) => ({
        anchor: captureRestoreAnchor(layers, layer.id, context.projectId, context.editRevision)!,
        layers: [layer],
      }));
    return prepared(
      { ids: [...ids], type: 'removeCanvasLayers' },
      { add, enabledUpdates: [], selectedLayerId, type: 'applyCanvasLayerStackMutation' },
      {
        history: 'record',
        postconditions: [...stackOrders(remaining, touchedStacks), { id: selectionAfter, kind: 'selection' }],
        selectionAfter,
        touchedIds: ids,
        touchedStacks,
      }
    );
  };

  const prepareDuplicate = (command: Extract<FlatDocumentCommand, { type: 'duplicate' }>): PrepareFlatEditResult => {
    const source = index.byId.get(command.sourceId);
    if (!source) {
      return missing([command.sourceId]);
    }
    if (index.byId.has(command.newId)) {
      return { reason: 'id-exists', status: 'invalid-target', targetId: command.newId };
    }
    const stackIds = getStackOrder(layers, source.stack).orderedIds;
    const orderedIds = [...stackIds.slice(0, source.stackIndex), command.newId, ...stackIds.slice(source.stackIndex)];
    return prepared(
      { newId: command.newId, sourceId: command.sourceId, type: 'duplicateCanvasLayer' },
      { enabledUpdates: [], removeIds: [command.newId], selectedLayerId, type: 'applyCanvasLayerStackMutation' },
      {
        history: 'record',
        postconditions: [
          { kind: 'stack-order', orderedIds, stack: source.stack },
          { id: command.newId, kind: 'selection' },
        ],
        selectionAfter: command.newId,
        touchedIds: [command.newId],
        touchedStacks: [source.stack],
      }
    );
  };

  const prepareReorder = (
    stacks: readonly { stack: LayerStackKind; orderedIds: readonly string[] }[]
  ): PrepareFlatEditResult => {
    if (stacks.length === 0) {
      return { operation: 'reorder nothing', status: 'unsupported' };
    }
    if (new Set(stacks.map((command) => command.stack)).size !== stacks.length) {
      return { operation: 'reorder one stack twice', status: 'unsupported' };
    }
    const touchedIds: string[] = [];
    for (const command of stacks) {
      const current = getStackOrder(layers, command.stack).orderedIds;
      const unknown = command.orderedIds.filter((id) => !index.byId.has(id));
      if (unknown.length > 0) {
        return missing(unknown);
      }
      const foreign = command.orderedIds.find((id) => index.byId.get(id)!.stack !== command.stack);
      if (foreign !== undefined) {
        return { reason: 'foreign-stack', status: 'invalid-target', targetId: foreign };
      }
      if (!reorderLayerStack(layers, command)) {
        return {
          reason: 'not-stack-members',
          status: 'invalid-target',
          targetId: command.orderedIds[0] ?? current[0]!,
        };
      }
      touchedIds.push(...command.orderedIds.filter((id, position) => current[position] !== id));
    }
    if (touchedIds.length === 0) {
      return { status: 'unchanged' };
    }
    return prepared(
      {
        stacks: stacks.map((command) => ({ orderedIds: [...command.orderedIds], stack: command.stack })),
        type: 'reorderCanvasLayerStacks',
      },
      { stacks: stacks.map((command) => getStackOrder(layers, command.stack)), type: 'reorderCanvasLayerStacks' },
      {
        history: 'record',
        postconditions: stacks.map((command) => ({
          kind: 'stack-order',
          orderedIds: command.orderedIds,
          stack: command.stack,
        })),
        selectionAfter: selectedLayerId,
        touchedIds,
        touchedStacks: stacksTopFirst(stacks.map((command) => command.stack)),
      }
    );
  };

  const prepareMove = (command: Extract<FlatDocumentCommand, { type: 'move' }>): PrepareFlatEditResult => {
    const ids = unique(command.ids);
    if (ids.length === 0) {
      return { operation: 'move nothing', status: 'unsupported' };
    }
    const found = lookup(ids);
    if ('status' in found) {
      return found;
    }
    const stacks = moveLayersWithinStacks(layers, ids, command.kind);
    return stacks.length === 0 ? { status: 'unchanged' } : prepareReorder(stacks);
  };

  const preparePatch = (command: Extract<FlatDocumentCommand, { type: 'patch' }>): PrepareFlatEditResult => {
    const entry = index.byId.get(command.id);
    if (!entry) {
      return missing([command.id]);
    }
    if (Object.keys(command.patch).length === 0) {
      return { operation: 'patch nothing', status: 'unsupported' };
    }
    if (command.before && !sameKeys(command.before, command.patch, PATCH_CONTAINERS)) {
      return { operation: 'patch baseline names other fields', status: 'unsupported' };
    }
    const inverse = command.before ?? patchInverse(entry.layer, command.patch);
    if (command.before ? sameValue(command.before, command.patch) : isPatchApplied(entry.layer, command.patch)) {
      return { status: 'unchanged' };
    }
    return prepared(
      { id: command.id, patch: command.patch, type: 'updateCanvasLayer' },
      { id: command.id, patch: inverse, type: 'updateCanvasLayer' },
      {
        history: 'record',
        postconditions: [{ id: command.id, kind: 'patched', patch: command.patch }],
        selectionAfter: selectedLayerId,
        touchedIds: [command.id],
        touchedStacks: [entry.stack],
      }
    );
  };

  const configInverse = (layer: CanvasLayerContract, config: CanvasLayerConfigPatch): CanvasLayerConfigPatch => {
    const current = layer as unknown as Record<string, unknown>;
    const inverse: Record<string, unknown> = { layerType: config.layerType };
    for (const [key, value] of Object.entries(config)) {
      if (key === 'layerType') {
        continue;
      }
      const before = current[key];
      inverse[key] =
        (key === 'adapter' || key === 'mask') &&
        typeof value === 'object' &&
        value !== null &&
        typeof before === 'object'
          ? Object.fromEntries(Object.keys(value).map((field) => [field, (before as Record<string, unknown>)[field]]))
          : before;
    }
    return inverse as CanvasLayerConfigPatch;
  };

  const preparePatchConfig = (
    command: Extract<FlatDocumentCommand, { type: 'patch-config' }>
  ): PrepareFlatEditResult => {
    const entry = index.byId.get(command.id);
    if (!entry) {
      return missing([command.id]);
    }
    if (entry.layer.type !== command.config.layerType) {
      return { actual: entry.layer.type, expected: [command.config.layerType], status: 'wrong-type' };
    }
    if (Object.keys(command.config).length <= 1) {
      return { operation: 'patch nothing', status: 'unsupported' };
    }
    if (command.before && command.before.layerType !== command.config.layerType) {
      return { operation: 'config baseline names another layer type', status: 'unsupported' };
    }
    if (command.before && !sameKeys(command.before, command.config, CONFIG_CONTAINERS)) {
      return { operation: 'config baseline names other fields', status: 'unsupported' };
    }
    if (command.before ? sameValue(command.before, command.config) : isConfigApplied(entry.layer, command.config)) {
      return { status: 'unchanged' };
    }
    return prepared(
      { config: command.config, id: command.id, type: 'updateCanvasLayerConfig' },
      {
        config: command.before ?? configInverse(entry.layer, command.config),
        id: command.id,
        type: 'updateCanvasLayerConfig',
      },
      {
        history: 'record',
        postconditions: [{ config: command.config, id: command.id, kind: 'config' }],
        selectionAfter: selectedLayerId,
        touchedIds: [command.id],
        touchedStacks: [entry.stack],
      }
    );
  };

  const preparePatchSource = (
    command: Extract<FlatDocumentCommand, { type: 'patch-source' }>
  ): PrepareFlatEditResult => {
    const entry = index.byId.get(command.id);
    if (!entry) {
      return missing([command.id]);
    }
    if (entry.layer.type !== 'raster' && entry.layer.type !== 'control') {
      return { actual: entry.layer.type, expected: ['raster', 'control'], status: 'wrong-type' };
    }
    if (entry.layer.source === command.source) {
      return { status: 'unchanged' };
    }
    return prepared(
      { id: command.id, source: command.source, type: 'updateCanvasLayerSource' },
      { id: command.id, source: entry.layer.source, type: 'updateCanvasLayerSource' },
      {
        history: 'record',
        postconditions: [{ id: command.id, kind: 'source', source: command.source }],
        selectionAfter: selectedLayerId,
        touchedIds: [command.id],
        touchedStacks: [entry.stack],
      }
    );
  };

  const prepareFlags = (
    command: Extract<FlatDocumentCommand, { type: 'set-enabled' | 'set-hidden' | 'set-locked' }>
  ): PrepareFlatEditResult => {
    const ids = unique(command.updates.map((update) => update.id));
    if (ids.length === 0) {
      return { operation: `${command.type} nothing`, status: 'unsupported' };
    }
    const found = lookup(ids);
    if ('status' in found) {
      return found;
    }
    if (command.type === 'set-hidden') {
      const notHideable = found.entries.find((entry) => !isHideableLayer(entry.layer));
      if (notHideable) {
        return {
          actual: notHideable.layer.type,
          expected: ['control', 'inpaint_mask', 'regional_guidance'],
          status: 'wrong-type',
        };
      }
    }
    const detail = (updated: readonly { id: string }[]) => ({
      history: 'record' as const,
      selectionAfter: selectedLayerId,
      touchedIds: updated.map((update) => update.id),
      touchedStacks: stacksTopFirst(updated.map((update) => index.byId.get(update.id)!.stack)),
    });
    switch (command.type) {
      case 'set-enabled': {
        const updates = command.updates.filter(
          (update) => index.byId.get(update.id)!.layer.isEnabled !== update.isEnabled
        );
        if (updates.length === 0) {
          return { status: 'unchanged' };
        }
        return prepared(
          { type: 'setCanvasLayersEnabled', updates },
          {
            type: 'setCanvasLayersEnabled',
            updates: updates.map((update) => ({
              id: update.id,
              isEnabled: index.byId.get(update.id)!.layer.isEnabled,
            })),
          },
          {
            ...detail(updates),
            postconditions: updates.map((update) => ({
              id: update.id,
              kind: 'patched',
              patch: { isEnabled: update.isEnabled },
            })),
          }
        );
      }
      case 'set-hidden': {
        const updates = command.updates.filter(
          (update) => isLayerHidden(index.byId.get(update.id)!.layer) !== update.isHidden
        );
        if (updates.length === 0) {
          return { status: 'unchanged' };
        }
        return prepared(
          { type: 'setCanvasLayersHidden', updates },
          {
            type: 'setCanvasLayersHidden',
            updates: updates.map((update) => ({
              id: update.id,
              isHidden: isLayerHidden(index.byId.get(update.id)!.layer),
            })),
          },
          {
            ...detail(updates),
            postconditions: updates.map((update) => ({ id: update.id, isHidden: update.isHidden, kind: 'hidden' })),
          }
        );
      }
      case 'set-locked': {
        const updates = command.updates.filter(
          (update) => index.byId.get(update.id)!.layer.isLocked !== update.isLocked
        );
        if (updates.length === 0) {
          return { status: 'unchanged' };
        }
        return prepared(
          { enabledUpdates: [], lockedUpdates: updates, type: 'applyCanvasLayerStackMutation' },
          {
            enabledUpdates: [],
            lockedUpdates: updates.map((update) => ({
              id: update.id,
              isLocked: index.byId.get(update.id)!.layer.isLocked,
            })),
            type: 'applyCanvasLayerStackMutation',
          },
          {
            ...detail(updates),
            postconditions: updates.map((update) => ({
              id: update.id,
              kind: 'patched',
              patch: { isLocked: update.isLocked },
            })),
          }
        );
      }
    }
  };

  const prepareSelect = (command: Extract<FlatDocumentCommand, { type: 'select' }>): PrepareFlatEditResult => {
    if (command.id !== null && !index.byId.has(command.id)) {
      return missing([command.id]);
    }
    if (command.id === selectedLayerId) {
      return { status: 'unchanged' };
    }
    return prepared(
      { id: command.id, type: 'setCanvasSelectedLayer' },
      { id: selectedLayerId, type: 'setCanvasSelectedLayer' },
      {
        history: 'none',
        postconditions: [{ id: command.id, kind: 'selection' }],
        selectionAfter: command.id,
        touchedIds: [],
        touchedStacks: [],
      }
    );
  };

  return {
    canMergeDown: (upperId) => mergeDownEligibility(document, upperId),
    compileLeaves: () => compileLeaves(document, index),
    document,
    getLayer: (id) => index.byId.get(id)?.layer ?? null,
    getStack: (kind) => index.stacks[kind],
    prepare: (command) => {
      switch (command.type) {
        case 'insert':
          return prepareInsert(command);
        case 'remove':
          return prepareRemove(command);
        case 'duplicate':
          return prepareDuplicate(command);
        case 'move':
          return prepareMove(command);
        case 'reorder':
          return prepareReorder(command.stacks);
        case 'patch':
          return preparePatch(command);
        case 'patch-config':
          return preparePatchConfig(command);
        case 'patch-source':
          return preparePatchSource(command);
        case 'set-enabled':
        case 'set-hidden':
        case 'set-locked':
          return prepareFlags(command);
        case 'select':
          return prepareSelect(command);
      }
    },
  };
};
