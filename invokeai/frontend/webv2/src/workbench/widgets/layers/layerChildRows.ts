import type {
  CanvasDocumentContractV3,
  DocumentCommand,
  LayerStackKind,
  SemanticNode,
} from '@workbench/canvas-engine/api';

import { getDocumentLayer } from '@workbench/canvas-engine/api';
import { layerChildRowKey } from '@workbench/layerPanelState';

export { layerChildRowKey };

/**
 * The Layers panel's projected child rows: per-layer modifiers (reference
 * images today) presented as rows beneath the layer that owns them. Rows are
 * a pure projection of config the layer already carries — the document keeps
 * its closed node union, and every edit round-trips through the same
 * `patch-config` seam the Properties pane uses.
 */

export type LayerChildRowKind = 'reference-image';

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
}

export type LayerChildRowAction = { type: 'set-enabled'; isEnabled: boolean } | { type: 'remove' };

const EMPTY_CHILD_ROWS: readonly ProjectedChildRow[] = [];

const childRowsByNode = new WeakMap<SemanticNode, readonly ProjectedChildRow[]>();

/** The child rows a layer projects; the identical array while the node is unchanged. */
export const projectLayerChildRows = (vm: SemanticNode): readonly ProjectedChildRow[] => {
  const { node } = vm;
  if (node.type !== 'regional_guidance' || node.referenceImages.length === 0) {
    return EMPTY_CHILD_ROWS;
  }
  const cached = childRowsByNode.get(vm);
  if (cached) {
    return cached;
  }
  const setSize = node.referenceImages.length;
  const rows = node.referenceImages.map((ref, index): ProjectedChildRow => ({
    depth: vm.depth + 1,
    image: ref.config.image
      ? { imageName: ref.config.image.imageName, thumbnailUrl: ref.config.image.thumbnailUrl }
      : null,
    isEnabled: ref.isEnabled,
    itemId: ref.id,
    key: layerChildRowKey(node.id, ref.id),
    kind: 'reference-image',
    layerId: node.id,
    parentContributing: vm.contributionEnabled,
    posInSet: index + 1,
    setSize,
    stack: vm.stack,
  }));
  childRowsByNode.set(vm, rows);
  return rows;
};

/**
 * The document command a child-row action resolves to, or `null` when the
 * layer or item is gone or the action changes nothing. Both sides of the patch
 * carry the whole array, exactly as the Properties pane commits it.
 */
export const layerChildRowCommand = (
  document: CanvasDocumentContractV3,
  target: Pick<ProjectedChildRow, 'layerId' | 'itemId'>,
  action: LayerChildRowAction
): Extract<DocumentCommand, { type: 'patch-config' }> | null => {
  const layer = getDocumentLayer(document, target.layerId);
  if (layer?.type !== 'regional_guidance' || !layer.referenceImages.some((ref) => ref.id === target.itemId)) {
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
};
