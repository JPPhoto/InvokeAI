import type {
  CanvasDocumentContractV2,
  CanvasLayerContract,
  CanvasLayerSourceContract,
} from '@workbench/canvas-engine/contracts';
import type { LayerStackKind } from '@workbench/canvas-engine/document/layerStacks';
import type { CanvasLayerBasePatch, CanvasLayerConfigPatch } from '@workbench/canvas-engine/mutationContracts';

import { isLayerHidden } from '@workbench/canvas-engine/document/layerEligibility';
import { getStackOrder } from '@workbench/canvas-engine/document/layerStacks';

/** What a document must show after a prepared edit landed; evaluated against the reducer document. */
export type FlatEditPostcondition =
  | { readonly kind: 'present'; readonly ids: readonly string[] }
  | { readonly kind: 'absent'; readonly ids: readonly string[] }
  | { readonly kind: 'stack-order'; readonly stack: LayerStackKind; readonly orderedIds: readonly string[] }
  | { readonly kind: 'selection'; readonly id: string | null }
  | { readonly kind: 'patched'; readonly id: string; readonly patch: CanvasLayerBasePatch }
  | { readonly kind: 'config'; readonly id: string; readonly config: CanvasLayerConfigPatch }
  | { readonly kind: 'source'; readonly id: string; readonly source: CanvasLayerSourceContract }
  | { readonly kind: 'hidden'; readonly id: string; readonly isHidden: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Structural equality over the plain data a layer contract holds. */
export const sameValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameValue(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => sameValue(left[key], right[key]));
};

/** Whether every field named by `patch` already holds its value on `layer`. */
export const isPatchApplied = (layer: CanvasLayerContract, patch: CanvasLayerBasePatch): boolean =>
  (Object.keys(patch) as (keyof CanvasLayerBasePatch)[]).every((key) =>
    key === 'transform'
      ? (Object.keys(patch.transform ?? {}) as (keyof CanvasLayerContract['transform'])[]).every(
          (axis) => layer.transform[axis] === patch.transform?.[axis]
        )
      : layer[key] === patch[key]
  );

/** Whether every field named by `config` already holds its value; nested partials compare field by field. */
export const isConfigApplied = (layer: CanvasLayerContract, config: CanvasLayerConfigPatch): boolean => {
  if (layer.type !== config.layerType) {
    return false;
  }
  const target = layer as unknown as Record<string, unknown>;
  return Object.entries(config).every(([key, value]) => {
    if (key === 'layerType') {
      return true;
    }
    const current = target[key];
    return isRecord(value) && isRecord(current) && (key === 'adapter' || key === 'mask')
      ? Object.entries(value).every(([field, expected]) => sameValue(current[field], expected))
      : sameValue(current, value);
  });
};

export const checkFlatEditPostconditions = (
  document: CanvasDocumentContractV2,
  postconditions: readonly FlatEditPostcondition[]
): boolean =>
  postconditions.every((postcondition) => {
    switch (postcondition.kind) {
      case 'present':
        return postcondition.ids.every((id) => document.layers.some((layer) => layer.id === id));
      case 'absent':
        return postcondition.ids.every((id) => !document.layers.some((layer) => layer.id === id));
      case 'stack-order': {
        const { orderedIds } = getStackOrder(document.layers, postcondition.stack);
        return (
          orderedIds.length === postcondition.orderedIds.length &&
          orderedIds.every((id, index) => id === postcondition.orderedIds[index])
        );
      }
      case 'selection':
        return document.selectedLayerId === postcondition.id;
      case 'patched': {
        const layer = document.layers.find((candidate) => candidate.id === postcondition.id);
        return layer !== undefined && isPatchApplied(layer, postcondition.patch);
      }
      case 'config': {
        const layer = document.layers.find((candidate) => candidate.id === postcondition.id);
        return layer !== undefined && isConfigApplied(layer, postcondition.config);
      }
      case 'source': {
        const layer = document.layers.find((candidate) => candidate.id === postcondition.id);
        return layer !== undefined && 'source' in layer && layer.source === postcondition.source;
      }
      case 'hidden': {
        const layer = document.layers.find((candidate) => candidate.id === postcondition.id);
        return layer !== undefined && isLayerHidden(layer) === postcondition.isHidden;
      }
    }
  });
