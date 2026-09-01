import { createEmptyPaintLayer } from '@workbench/widgets/layers/layerOps';
import { describe, expect, it } from 'vitest';

import { isLayerEditingDisabled } from './LayerBlendRow';

describe('LayerBlendRow editing state', () => {
  it('disables layer controls without a selection or while engine editing is locked', () => {
    const layer = createEmptyPaintLayer('Layer', 'layer');
    expect(isLayerEditingDisabled(null, false)).toBe(true);
    expect(isLayerEditingDisabled(layer, true)).toBe(true);
    expect(isLayerEditingDisabled(layer, false)).toBe(false);
  });
});
