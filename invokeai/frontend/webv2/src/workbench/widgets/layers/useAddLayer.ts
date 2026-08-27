import type { CanvasLayerContract } from '@workbench/canvas-engine/api';

import { useModelsSelector } from '@features/models';
import { useCanvasEngine } from '@workbench/widgets/canvas/useCanvasEngine';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { nextLayerName } from '@workbench/workbenchState';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import type { AddLayerItemId } from './addLayerMenu';

import { isAddLayerItemAvailable } from './addLayerMenu';
import { resolveDefaultControlModelForBase } from './controlModelOptions';
import {
  createControlLayer,
  createEmptyPaintLayer,
  createInpaintMaskLayer,
  createRegionalGuidanceLayer,
  createRegionalGuidanceLayerWithRefImage,
  nextControlLayerName,
  nextInpaintMaskName,
  nextRegionalGuidanceName,
} from './layerOps';
import { useSelectedModelBase } from './useSelectedModelBase';

/**
 * Returns a single `addLayer(id)` callback that creates a new layer of the given
 * kind through the guarded structural commit (one undoable history entry per
 * add). Reused by the panel's add-layer menu AND each group header's "New"
 * button so both surfaces stay in lockstep.
 */
export const useAddLayer = (): ((id: AddLayerItemId) => void) => {
  const { t } = useTranslation();
  const engine = useCanvasEngine();
  const commitPrepared = usePreparedCommit(engine);
  const base = useSelectedModelBase();
  const models = useModelsSelector((snapshot) => snapshot.models);
  const layerNames = useActiveProjectSelector(
    (project) => project.canvas.document.layers.map((layer) => layer.name),
    (left, right) => left.length === right.length && left.every((name, index) => name === right[index])
  );
  const regionalGuidanceCount = useActiveProjectSelector(
    (project) => project.canvas.document.layers.filter((layer) => layer.type === 'regional_guidance').length
  );

  return useCallback(
    (id: AddLayerItemId) => {
      if (!isAddLayerItemAvailable(id, base)) {
        return;
      }
      const add = (label: string, layer: CanvasLayerContract): void => {
        commitPrepared(label, (model) =>
          model.prepare({ aboveId: model.document.selectedLayerId, layers: [layer], type: 'insert' })
        );
      };
      switch (id) {
        case 'raster': {
          const layer = createEmptyPaintLayer(nextLayerName(layerNames));
          add(t('widgets.layers.actions.addRasterLayer'), layer);
          return;
        }
        case 'control': {
          const layer = createControlLayer(
            nextControlLayerName(layerNames),
            undefined,
            base,
            resolveDefaultControlModelForBase(models, base)
          );
          add(t('widgets.layers.actions.addControlLayer'), layer);
          return;
        }
        case 'inpaint_mask': {
          const layer = createInpaintMaskLayer(nextInpaintMaskName(layerNames));
          add(t('widgets.layers.actions.addInpaintMask'), layer);
          return;
        }
        case 'regional_guidance': {
          const layer = createRegionalGuidanceLayer(nextRegionalGuidanceName(layerNames), regionalGuidanceCount);
          add(t('widgets.layers.actions.addRegionalGuidance'), layer);
          return;
        }
        case 'regional_reference_image': {
          const layer = createRegionalGuidanceLayerWithRefImage(
            nextRegionalGuidanceName(layerNames),
            regionalGuidanceCount,
            base
          );
          add(t('widgets.layers.actions.addRegionalReferenceImage'), layer);
          return;
        }
      }
    },
    [base, commitPrepared, layerNames, models, regionalGuidanceCount, t]
  );
};
