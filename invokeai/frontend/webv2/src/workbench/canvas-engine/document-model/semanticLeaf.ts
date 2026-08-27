import type { CanvasLayerContract } from '@workbench/canvas-engine/contracts';
import type { LayerStackKind } from '@workbench/canvas-engine/document/layerStacks';
import type { Mat2d } from '@workbench/canvas-engine/types';

import { isLayerContributing, isLayerHidden } from '@workbench/canvas-engine/document/layerEligibility';
import { layerStackOf } from '@workbench/canvas-engine/document/layerStacks';
import { fromTRS } from '@workbench/canvas-engine/math/mat2d';

/** Document facts about one layer; nothing about the screen, the panel or the session. */
export interface SemanticLeafV2 {
  readonly id: string;
  readonly stack: LayerStackKind;
  readonly layer: CanvasLayerContract;
  readonly contributionEnabled: boolean;
  readonly documentHidden: boolean;
  readonly locked: boolean;
  readonly worldTransform: Mat2d;
}

export const compileSemanticLeaf = (layer: CanvasLayerContract): SemanticLeafV2 => ({
  contributionEnabled: isLayerContributing(layer),
  documentHidden: isLayerHidden(layer),
  id: layer.id,
  layer,
  locked: layer.isLocked,
  stack: layerStackOf(layer),
  worldTransform: fromTRS(
    { x: layer.transform.x, y: layer.transform.y },
    layer.transform.rotation,
    layer.transform.scaleX,
    layer.transform.scaleY
  ),
});
