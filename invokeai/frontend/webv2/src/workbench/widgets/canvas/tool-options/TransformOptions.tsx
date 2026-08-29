import type { NumberInput as ChakraNumberInput } from '@chakra-ui/react';
import type { LayerTransform } from '@workbench/canvas-engine/api';
import type {
  ToolbarRegionProps,
  ToolbarStatusProps,
  ToolPresentationAdapter,
} from '@workbench/widgets/canvas/tool-presentation/toolbarContracts';

import { useCanvasHasFloatingSelection, useTransformSession } from '@workbench/widgets/canvas/engineStoreHooks';
import { ToolbarNumberField, ToolbarStatus } from '@workbench/widgets/canvas/tool-presentation/ToolbarPrimitives';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Edits go to the session preview through the engine; nothing reaches the
 * document until Apply, and the whole session is one undo entry. Scale is a
 * percent of the layer's native size because the session carries only the
 * transform, not the source pixel dimensions.
 */
const useTransformPatch = (engine: ToolbarRegionProps['engine']) => {
  const session = useTransformSession(engine);
  const transform = session?.transform ?? null;
  const patch = useCallback(
    (next: Partial<LayerTransform>) => {
      if (transform) {
        engine.layers.updateTransformSession({ ...transform, ...next });
      }
    },
    [engine, transform]
  );
  return { patch, transform };
};

type NumberChange = ChakraNumberInput.ValueChangeDetails;

const TransformPosition = ({ engine }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const { patch, transform } = useTransformPatch(engine);
  const onX = useCallback(
    ({ valueAsNumber }: NumberChange) => Number.isFinite(valueAsNumber) && patch({ x: Math.round(valueAsNumber) }),
    [patch]
  );
  const onY = useCallback(
    ({ valueAsNumber }: NumberChange) => Number.isFinite(valueAsNumber) && patch({ y: Math.round(valueAsNumber) }),
    [patch]
  );
  return (
    <>
      <ToolbarNumberField
        aria-label={t('widgets.canvas.toolOptions.positionX')}
        disabled={!transform}
        label={t('widgets.canvas.toolOptions.positionX')}
        value={transform ? String(Math.round(transform.x)) : ''}
        onValueChange={onX}
      />
      <ToolbarNumberField
        aria-label={t('widgets.canvas.toolOptions.positionY')}
        disabled={!transform}
        label={t('widgets.canvas.toolOptions.positionY')}
        value={transform ? String(Math.round(transform.y)) : ''}
        onValueChange={onY}
      />
    </>
  );
};

const TransformScale = ({ engine }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const { patch, transform } = useTransformPatch(engine);
  const onScaleX = useCallback(
    ({ valueAsNumber }: NumberChange) =>
      Number.isFinite(valueAsNumber) && valueAsNumber !== 0 && patch({ scaleX: valueAsNumber / 100 }),
    [patch]
  );
  const onScaleY = useCallback(
    ({ valueAsNumber }: NumberChange) =>
      Number.isFinite(valueAsNumber) && valueAsNumber !== 0 && patch({ scaleY: valueAsNumber / 100 }),
    [patch]
  );
  const onRotation = useCallback(
    ({ valueAsNumber }: NumberChange) =>
      Number.isFinite(valueAsNumber) && patch({ rotation: valueAsNumber * DEG_TO_RAD }),
    [patch]
  );
  return (
    <>
      <ToolbarNumberField
        aria-label={t('widgets.canvas.toolOptions.scaleWidth')}
        disabled={!transform}
        label={t('widgets.canvas.toolOptions.frameWidth')}
        value={transform ? String(round2(transform.scaleX * 100)) : ''}
        onValueChange={onScaleX}
      />
      <ToolbarNumberField
        aria-label={t('widgets.canvas.toolOptions.scaleHeight')}
        disabled={!transform}
        label={t('widgets.canvas.toolOptions.frameHeight')}
        value={transform ? String(round2(transform.scaleY * 100)) : ''}
        onValueChange={onScaleY}
      />
      <ToolbarNumberField
        aria-label={t('widgets.canvas.toolOptions.rotation')}
        disabled={!transform}
        suffix="°"
        value={transform ? String(round2(transform.rotation * RAD_TO_DEG)) : ''}
        onValueChange={onRotation}
      />
    </>
  );
};

/**
 * Apply / Cancel stay live for a floating selection, which frames its own
 * pixels instead of opening a layer session; the numerics stay disabled
 * because the float's transform is layer-local, not document space.
 */
const TransformStatus = ({ engine }: ToolbarStatusProps) => {
  const session = useTransformSession(engine);
  const hasFloat = useCanvasHasFloatingSelection(engine);
  const disabled = !session && !hasFloat;
  const onApply = useCallback(() => engine.layers.applyTransform(), [engine]);
  const onCancel = useCallback(() => engine.layers.cancelTransform(), [engine]);
  return <ToolbarStatus applyDisabled={disabled} cancelDisabled={disabled} onApply={onApply} onCancel={onCancel} />;
};

export const transformAdapter: ToolPresentationAdapter = {
  rowLabels: { geometry: 'widgets.transform.position', modes: 'widgets.transform.scale' },
  geometry: TransformPosition,
  id: 'transform',
  modes: TransformScale,
  status: TransformStatus,
};
