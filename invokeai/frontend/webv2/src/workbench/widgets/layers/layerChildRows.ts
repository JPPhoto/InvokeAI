import type {
  CanvasDocumentContractV3,
  CanvasInpaintMaskLayerContract,
  DocumentCommand,
  LayerStackKind,
  SemanticNode,
} from '@workbench/canvas-engine/api';

import { getDocumentLayer } from '@workbench/canvas-engine/api';
import { layerChildRowKey } from '@workbench/layerPanelState';

export { layerChildRowKey };

/**
 * The Layers panel's projected child rows: per-layer modifiers (reference
 * images, mask noise and denoise limit) presented as rows beneath the layer
 * that owns them. Rows are a pure projection of config the layer already
 * carries — the document keeps its closed node union, and every edit
 * round-trips through the same `patch-config` seam the Properties pane uses.
 */

export type LayerChildRowKind = 'reference-image' | 'mask-noise' | 'mask-denoise';

/** The synthetic item ids of a mask's singleton modifiers. */
export const MASK_NOISE_ITEM_ID = 'noise';
export const MASK_DENOISE_ITEM_ID = 'denoise';

export interface ProjectedChildRow {
  /** Tree key, also the row's DOM id: `child:{layerId}:{itemId}`. */
  readonly key: string;
  readonly kind: LayerChildRowKind;
  readonly layerId: string;
  readonly itemId: string;
  readonly stack: LayerStackKind;
  /** One level below the owning layer. */
  readonly depth: number;
  readonly posInSet: number;
  readonly setSize: number;
  readonly isEnabled: boolean;
  /** The owning layer and its ancestors are enabled; a gated dot when not. */
  readonly parentContributing: boolean;
  readonly image: { readonly imageName: string; readonly thumbnailUrl: string } | null;
  /** The modifier's 0–1 magnitude, shown beside the name; `null` for reference images. */
  readonly value: number | null;
}

export type LayerChildRowAction = { type: 'set-enabled'; isEnabled: boolean } | { type: 'remove' };

/** A child row's live item facts, resolved from the document; `null` when it is gone. */
export interface LayerChildItem {
  readonly kind: LayerChildRowKind;
  readonly isEnabled: boolean;
}

const EMPTY_CHILD_ROWS: readonly ProjectedChildRow[] = [];

const childRowsByNode = new WeakMap<SemanticNode, readonly ProjectedChildRow[]>();

const baseRow = (vm: SemanticNode) => ({
  depth: vm.depth + 1,
  layerId: vm.node.id,
  parentContributing: vm.contributionEnabled,
  stack: vm.stack,
});

const maskModifierRows = (vm: SemanticNode, layer: CanvasInpaintMaskLayerContract): ProjectedChildRow[] => {
  const items = [
    layer.noise
      ? {
          isEnabled: layer.noise.isEnabled,
          itemId: MASK_NOISE_ITEM_ID,
          kind: 'mask-noise' as const,
          value: layer.noise.level,
        }
      : null,
    layer.denoise
      ? {
          isEnabled: layer.denoise.isEnabled,
          itemId: MASK_DENOISE_ITEM_ID,
          kind: 'mask-denoise' as const,
          value: layer.denoise.limit,
        }
      : null,
  ].filter((item) => item !== null);
  return items.map((item, index) => ({
    ...baseRow(vm),
    ...item,
    image: null,
    key: layerChildRowKey(layer.id, item.itemId),
    posInSet: index + 1,
    setSize: items.length,
  }));
};

/** The child rows a layer projects; the identical array while the node is unchanged. */
export const projectLayerChildRows = (vm: SemanticNode): readonly ProjectedChildRow[] => {
  const { node } = vm;
  const cached = childRowsByNode.get(vm);
  if (cached) {
    return cached;
  }
  let rows: readonly ProjectedChildRow[];
  if (node.type === 'regional_guidance' && node.referenceImages.length > 0) {
    const setSize = node.referenceImages.length;
    rows = node.referenceImages.map((ref, index): ProjectedChildRow => ({
      ...baseRow(vm),
      image: ref.config.image
        ? { imageName: ref.config.image.imageName, thumbnailUrl: ref.config.image.thumbnailUrl }
        : null,
      isEnabled: ref.isEnabled,
      itemId: ref.id,
      key: layerChildRowKey(node.id, ref.id),
      kind: 'reference-image',
      posInSet: index + 1,
      setSize,
      value: null,
    }));
  } else if (node.type === 'inpaint_mask' && (node.noise || node.denoise)) {
    rows = maskModifierRows(vm, node);
  } else {
    return EMPTY_CHILD_ROWS;
  }
  childRowsByNode.set(vm, rows);
  return rows;
};

/** Resolves a child row's item from the live document; `null` when the layer or item is gone. */
export const getLayerChildItem = (
  document: CanvasDocumentContractV3,
  layerId: string,
  itemId: string
): LayerChildItem | null => {
  const layer = getDocumentLayer(document, layerId);
  if (layer?.type === 'regional_guidance') {
    const ref = layer.referenceImages.find((entry) => entry.id === itemId);
    return ref ? { isEnabled: ref.isEnabled, kind: 'reference-image' } : null;
  }
  if (layer?.type === 'inpaint_mask') {
    if (itemId === MASK_NOISE_ITEM_ID && layer.noise) {
      return { isEnabled: layer.noise.isEnabled, kind: 'mask-noise' };
    }
    if (itemId === MASK_DENOISE_ITEM_ID && layer.denoise) {
      return { isEnabled: layer.denoise.isEnabled, kind: 'mask-denoise' };
    }
  }
  return null;
};

/** The i18n key naming a child row's removal, for menus and history entries alike. */
export const layerChildRemoveLabelKey = (kind: LayerChildRowKind): string => {
  switch (kind) {
    case 'reference-image':
      return 'widgets.layers.regionalGuidance.removeReferenceImage';
    case 'mask-noise':
      return 'widgets.layers.modifiers.removeNoise';
    case 'mask-denoise':
      return 'widgets.layers.modifiers.removeDenoise';
  }
};

type PatchConfigCommand = Extract<DocumentCommand, { type: 'patch-config' }>;

/**
 * The document command a child-row action resolves to, or `null` when the
 * layer or item is gone or the action changes nothing. Both sides of the patch
 * carry the modifier's whole value, exactly as the Properties editors commit.
 */
export const layerChildRowCommand = (
  document: CanvasDocumentContractV3,
  target: Pick<ProjectedChildRow, 'layerId' | 'itemId'>,
  action: LayerChildRowAction
): PatchConfigCommand | null => {
  const layer = getDocumentLayer(document, target.layerId);
  if (layer?.type === 'regional_guidance') {
    if (!layer.referenceImages.some((ref) => ref.id === target.itemId)) {
      return null;
    }
    const before = layer.referenceImages;
    const next =
      action.type === 'remove'
        ? before.filter((ref) => ref.id !== target.itemId)
        : before.map((ref) => (ref.id === target.itemId ? { ...ref, isEnabled: action.isEnabled } : ref));
    if (action.type === 'set-enabled' && before.every((ref, index) => next[index]!.isEnabled === ref.isEnabled)) {
      return null;
    }
    return {
      before: { layerType: 'regional_guidance', referenceImages: [...before] },
      config: { layerType: 'regional_guidance', referenceImages: next },
      id: target.layerId,
      type: 'patch-config',
    };
  }
  if (layer?.type === 'inpaint_mask') {
    const field =
      target.itemId === MASK_NOISE_ITEM_ID ? 'noise' : target.itemId === MASK_DENOISE_ITEM_ID ? 'denoise' : null;
    const current = field ? layer[field] : undefined;
    if (!field || !current) {
      return null;
    }
    const next = action.type === 'remove' ? null : { ...current, isEnabled: action.isEnabled };
    if (next && next.isEnabled === current.isEnabled) {
      return null;
    }
    return {
      before: { [field]: current, layerType: 'inpaint_mask' },
      config: { [field]: next, layerType: 'inpaint_mask' },
      id: target.layerId,
      type: 'patch-config',
    };
  }
  return null;
};
