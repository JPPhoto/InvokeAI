import type { CanvasLayerContract } from '@workbench/canvas-engine/contracts';

import type { LayerStackKind } from './layerStacks';

/**
 * Where a new layer lands in its stack, captured once against the document the caller saw.
 * Resolution is exact: before a surviving `beforeId`, else after a surviving `afterId`, else at
 * the top of `stack`. Ids that no longer belong to `stack` count as gone. The reducer refuses an
 * anchor from another project; a structural commit refuses one captured at an older edit revision.
 */
export interface FlatLayerInsertionAnchor {
  readonly projectId: string;
  readonly stack: LayerStackKind;
  readonly beforeId: string | null;
  readonly afterId: string | null;
  readonly capturedEditRevision: number;
}

export interface FlatLayerInsertion {
  readonly anchor: FlatLayerInsertionAnchor;
  readonly layers: readonly CanvasLayerContract[];
}

export interface InsertionAnchorCapture {
  readonly projectId: string;
  readonly stack: LayerStackKind;
  readonly editRevision: number;
  /** Land directly above this layer when it belongs to `stack`; otherwise at the stack top. */
  readonly aboveId?: string | null;
}

const stackMemberIndex = (layers: readonly CanvasLayerContract[], stack: LayerStackKind, id: string | null): number =>
  id === null ? -1 : layers.findIndex((layer) => layer.id === id && layer.type === stack);

const nearestAbove = (
  layers: readonly CanvasLayerContract[],
  index: number,
  stack: LayerStackKind
): CanvasLayerContract | undefined => {
  for (let position = index - 1; position >= 0; position -= 1) {
    if (layers[position]!.type === stack) {
      return layers[position];
    }
  }
  return undefined;
};

const nearestBelow = (
  layers: readonly CanvasLayerContract[],
  index: number,
  stack: LayerStackKind
): CanvasLayerContract | undefined => layers.slice(index + 1).find((layer) => layer.type === stack);

export const captureInsertionAnchor = (
  layers: readonly CanvasLayerContract[],
  capture: InsertionAnchorCapture
): FlatLayerInsertionAnchor => {
  const { editRevision, projectId, stack } = capture;
  const leafIndex = stackMemberIndex(layers, stack, capture.aboveId ?? null);
  if (leafIndex >= 0) {
    return {
      afterId: nearestAbove(layers, leafIndex, stack)?.id ?? null,
      beforeId: layers[leafIndex]!.id,
      capturedEditRevision: editRevision,
      projectId,
      stack,
    };
  }
  return {
    afterId: null,
    beforeId: layers.find((layer) => layer.type === stack)?.id ?? null,
    capturedEditRevision: editRevision,
    projectId,
    stack,
  };
};

/** The anchor that puts `layerId` back between its current same-stack neighbours once removed. */
export const captureRestoreAnchor = (
  layers: readonly CanvasLayerContract[],
  layerId: string,
  projectId: string,
  editRevision: number
): FlatLayerInsertionAnchor | null => {
  const index = layers.findIndex((layer) => layer.id === layerId);
  if (index < 0) {
    return null;
  }
  const stack = layers[index]!.type;
  return {
    afterId: nearestAbove(layers, index, stack)?.id ?? null,
    beforeId: nearestBelow(layers, index, stack)?.id ?? null,
    capturedEditRevision: editRevision,
    projectId,
    stack,
  };
};

export const resolveInsertionIndex = (
  layers: readonly CanvasLayerContract[],
  anchor: FlatLayerInsertionAnchor
): number => {
  const before = stackMemberIndex(layers, anchor.stack, anchor.beforeId);
  if (before >= 0) {
    return before;
  }
  const after = stackMemberIndex(layers, anchor.stack, anchor.afterId);
  if (after >= 0) {
    return after + 1;
  }
  const top = layers.findIndex((layer) => layer.type === anchor.stack);
  return top >= 0 ? top : 0;
};

export const insertLayersAtAnchor = <Layer extends CanvasLayerContract>(
  layers: readonly Layer[],
  anchor: FlatLayerInsertionAnchor,
  inserted: readonly Layer[]
): Layer[] => {
  const index = resolveInsertionIndex(layers, anchor);
  return [...layers.slice(0, index), ...inserted, ...layers.slice(index)];
};
