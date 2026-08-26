import type { CanvasLayerContract } from '@workbench/canvas-engine/contracts';

const nearestSurviving = (
  previousLayers: readonly CanvasLayerContract[],
  previousIndex: number,
  accept: (layer: CanvasLayerContract) => boolean
): string | null => {
  for (let index = previousIndex + 1; index < previousLayers.length; index += 1) {
    const layer = previousLayers[index]!;
    if (accept(layer)) {
      return layer.id;
    }
  }
  for (let index = previousIndex - 1; index >= 0; index -= 1) {
    const layer = previousLayers[index]!;
    if (accept(layer)) {
      return layer.id;
    }
  }
  return null;
};

/**
 * The primary selection after `layers` replaced `previousLayers`. A surviving selection is kept.
 * A removed one moves to its nearest surviving neighbour in the previous order, preferring its own
 * stack, below first, then above; without a previous order the top layer is selected.
 */
export const repairSelectedLayerId = (
  layers: readonly CanvasLayerContract[],
  selectedLayerId: string | null,
  previousLayers?: readonly CanvasLayerContract[]
): string | null => {
  if (selectedLayerId === null) {
    return null;
  }
  const surviving = new Set(layers.map((layer) => layer.id));
  if (surviving.has(selectedLayerId)) {
    return selectedLayerId;
  }
  const previousIndex = previousLayers?.findIndex((layer) => layer.id === selectedLayerId) ?? -1;
  if (previousLayers && previousIndex >= 0) {
    const stack = previousLayers[previousIndex]!.type;
    return (
      nearestSurviving(previousLayers, previousIndex, (layer) => surviving.has(layer.id) && layer.type === stack) ??
      nearestSurviving(previousLayers, previousIndex, (layer) => surviving.has(layer.id)) ??
      layers[0]?.id ??
      null
    );
  }
  return layers[0]?.id ?? null;
};
