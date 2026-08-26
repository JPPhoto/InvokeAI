import type { CanvasLayerContract } from '@workbench/canvas-engine/contracts';

/** Whether the layer takes part in rendering, generation and export. Display hiding never changes this. */
export const isLayerContributing = (layer: CanvasLayerContract): boolean => layer.isEnabled;

/** Whether the layer accepts document edits that move or repaint it. */
export const isLayerEditable = (layer: CanvasLayerContract): boolean => layer.isEnabled && !layer.isLocked;

/** Raster transparency lock: pixels may change, alpha may not. Brushes composite source-atop; erasing is refused. */
export const isLayerTransparencyLocked = (layer: CanvasLayerContract): boolean =>
  layer.type === 'raster' && layer.isTransparencyLocked === true;

/** Whether a stroke may land directly on the layer's pixels or mask. Control layers edit through a pixel-edit transaction. */
export const isLayerPaintable = (layer: CanvasLayerContract): boolean =>
  isLayerEditable(layer) && layer.type !== 'control';

/** Whether the layer holds pixels rather than a parametric source. */
export const isPixelBackedLayer = (layer: CanvasLayerContract): boolean =>
  (layer.type === 'raster' || layer.type === 'control') &&
  (layer.source.type === 'image' || layer.source.type === 'paint');

/** Enabled, unlocked raster pixels the engine can merge into or delete: masks, control, and parametric sources are not. */
export const isMergeableRasterLayer = (layer: CanvasLayerContract): boolean =>
  isLayerEditable(layer) && layer.type === 'raster' && isPixelBackedLayer(layer);
