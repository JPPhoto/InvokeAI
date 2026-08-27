import type { CanvasDocumentContractV2, CanvasLayerContract } from '@workbench/canvas-engine/contracts';

import { LAYER_STACK_ORDER } from '@workbench/canvas-engine/document/layerStacks';

const base = (id: string) => ({
  blendMode: 'normal' as const,
  id,
  isEnabled: true,
  isLocked: false,
  name: id,
  opacity: 1,
  transform: { rotation: 0, scaleX: 1, scaleY: 1, x: 0, y: 0 },
});

const mask = () => ({ bitmap: null, fill: { color: '#e07575', style: 'diagonal' as const } });

/** A complete layer contract of `type`, accepted by the reducer's normaliser as-is. */
export const layerContract = (
  id: string,
  type: CanvasLayerContract['type'] = 'raster',
  overrides: Partial<CanvasLayerContract> = {}
): CanvasLayerContract => {
  const contract = ((): CanvasLayerContract => {
    switch (type) {
      case 'raster':
        return { ...base(id), source: { bitmap: null, type: 'paint' }, type };
      case 'control':
        return {
          ...base(id),
          adapter: { beginEndStepPct: [0, 1], controlMode: 'balanced', kind: 'controlnet', model: null, weight: 1 },
          source: { bitmap: null, type: 'paint' },
          type,
          withTransparencyEffect: false,
        };
      case 'inpaint_mask':
        return { ...base(id), mask: mask(), type };
      case 'regional_guidance':
        return {
          ...base(id),
          autoNegative: false,
          mask: mask(),
          negativePrompt: null,
          positivePrompt: null,
          referenceImages: [],
          type,
        };
    }
  })();
  return { ...contract, ...overrides } as CanvasLayerContract;
};

export const flatDocument = (
  layers: readonly CanvasLayerContract[],
  selectedLayerId: string | null = null
): CanvasDocumentContractV2 => ({
  background: 'transparent',
  bbox: { height: 512, width: 512, x: 0, y: 0 },
  height: 512,
  layers: [...layers],
  selectedLayerId,
  version: 2,
  width: 512,
});

/** `count` layers cycling through every stack in flat order, ids `l0` (top) … `l{count-1}`. */
export const createLargeFlatDocument = (
  count: number,
  selectedLayerId: string | null = 'l0'
): CanvasDocumentContractV2 =>
  flatDocument(
    Array.from({ length: count }, (_, index) =>
      layerContract(`l${index}`, LAYER_STACK_ORDER[index % LAYER_STACK_ORDER.length]!)
    ),
    selectedLayerId
  );
