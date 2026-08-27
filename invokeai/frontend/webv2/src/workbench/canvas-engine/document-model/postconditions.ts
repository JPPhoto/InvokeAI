import type { CanvasDocumentContractV2, CanvasLayerContract } from '@workbench/canvas-engine/contracts';
import type { LayerStackKind } from '@workbench/canvas-engine/document/layerStacks';
import type { CanvasLayerBasePatch } from '@workbench/canvas-engine/mutationContracts';

import { getStackOrder } from '@workbench/canvas-engine/document/layerStacks';

/** What a document must show after a prepared edit landed; evaluated against the reducer document. */
export type FlatEditPostcondition =
  | { readonly kind: 'present'; readonly ids: readonly string[] }
  | { readonly kind: 'absent'; readonly ids: readonly string[] }
  | { readonly kind: 'stack-order'; readonly stack: LayerStackKind; readonly orderedIds: readonly string[] }
  | { readonly kind: 'selection'; readonly id: string | null }
  | { readonly kind: 'patched'; readonly id: string; readonly patch: CanvasLayerBasePatch };

/** Whether every field named by `patch` already holds its patched value on `layer`. */
export const isPatchApplied = (layer: CanvasLayerContract, patch: CanvasLayerBasePatch): boolean =>
  (Object.keys(patch) as (keyof CanvasLayerBasePatch)[]).every((key) =>
    key === 'transform'
      ? (Object.keys(patch.transform ?? {}) as (keyof CanvasLayerContract['transform'])[]).every(
          (axis) => layer.transform[axis] === patch.transform?.[axis]
        )
      : layer[key] === patch[key]
  );

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
    }
  });
