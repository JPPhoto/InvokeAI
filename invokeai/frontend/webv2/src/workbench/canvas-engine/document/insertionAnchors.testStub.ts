import type { CanvasLayerContract } from '@workbench/canvas-engine/contracts';

import type { FlatLayerInsertionAnchor } from './insertionAnchors';
import type { LayerStackKind } from './layerStacks';

import { captureInsertionAnchor } from './insertionAnchors';

export const stackTopAnchor = (projectId: string, stack: LayerStackKind = 'raster'): FlatLayerInsertionAnchor => ({
  afterId: null,
  beforeId: null,
  capturedEditRevision: 0,
  projectId,
  stack,
});

/** Captures the way the engine does, against whatever `getLayers` returns at call time. */
export const createTestInsertionAnchorCapture =
  (projectId: string, getLayers: () => readonly CanvasLayerContract[] = () => []) =>
  (stack: LayerStackKind, aboveId: string | null): FlatLayerInsertionAnchor =>
    captureInsertionAnchor(getLayers(), { aboveId, editRevision: 0, projectId, stack });
