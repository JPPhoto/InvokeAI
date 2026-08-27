import type { SelectValueChangeDetails, SliderValueChangeDetails } from '@chakra-ui/react';
import type { CanvasInpaintMaskLayerContract, CanvasMaskFillContract } from '@workbench/canvas-engine/api';
import type { CanvasStructuralEngine } from '@workbench/widgets/layers/layerOps';

import { createListCollection, HStack, Stack } from '@chakra-ui/react';
import { Button, ColorPicker, Field, Select, Slider } from '@platform/ui';
import { type CanvasPreparedEngine, usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { applyStructuralPreview } from './layerOps';

/** The six mask fill styles, matching `CanvasMaskFillContract['style']` / legacy `zFillStyle`. */
const MASK_FILL_STYLES: readonly CanvasMaskFillContract['style'][] = [
  'solid',
  'grid',
  'crosshatch',
  'diagonal',
  'horizontal',
  'vertical',
];

const formatUnitPercent = (value: number): string => `${Math.round(value * 100)}%`;

const noiseConfig = (value: number | undefined) => ({ layerType: 'inpaint_mask', noiseLevel: value }) as const;
const denoiseConfig = (value: number | undefined) => ({ layerType: 'inpaint_mask', denoiseLimit: value }) as const;

interface InpaintMaskSettingsProps {
  engine: (CanvasStructuralEngine & CanvasPreparedEngine) | null;
  layer: CanvasInpaintMaskLayerContract;
}

/**
 * Per-layer settings for a selected inpaint mask, rendered as a section under the
 * layers-panel header region (plan §1.3): fill colour + style, noise level and
 * denoise-limit sliders (0–1), and an in-place mask invert. `noiseLevel` /
 * `denoiseLimit` are wired to the contract now (consumed by the NEXT task's graph
 * builder); they have no generation effect yet. Fill/noise/denoise edits go
 * through the canvas undo stack as prepared `patch-config` edits;
 * invert is an engine pixel op (its own undoable image patch).
 */
export const InpaintMaskSettings = ({ engine, layer }: InpaintMaskSettingsProps) => {
  const { t } = useTranslation();
  const commitPrepared = usePreparedCommit(engine);
  const fillBeforeRef = useRef<CanvasMaskFillContract | null>(null);
  const noiseBeforeRef = useRef<{ value: number | undefined } | null>(null);
  const denoiseBeforeRef = useRef<{ value: number | undefined } | null>(null);

  const fill = layer.mask.fill;
  const noiseLevel = layer.noiseLevel ?? 0;
  const denoiseLimit = layer.denoiseLimit ?? 1;

  const styleCollection = useMemo(
    () =>
      createListCollection({
        items: MASK_FILL_STYLES.map((style) => ({
          label: t(`widgets.layers.maskFill.styles.${style}`),
          value: style,
        })),
      }),
    [t]
  );

  const commitFill = useCallback(
    (next: CanvasMaskFillContract, before: CanvasMaskFillContract) => {
      commitPrepared(t('widgets.layers.maskFill.fill'), (model) =>
        model.prepare({
          before: { layerType: 'inpaint_mask', mask: { fill: before } },
          config: { layerType: 'inpaint_mask', mask: { fill: next } },
          id: layer.id,
          type: 'patch-config',
        })
      );
    },
    [commitPrepared, layer.id, t]
  );

  const handleColorChange = useCallback(
    (hex: string) => {
      if (
        !applyStructuralPreview(engine, {
          config: { layerType: 'inpaint_mask', mask: { fill: { ...fill, color: hex } } },
          id: layer.id,
          type: 'updateCanvasLayerConfig',
        })
      ) {
        return;
      }
      if (fillBeforeRef.current === null) {
        fillBeforeRef.current = fill;
      }
    },
    [engine, fill, layer.id]
  );

  const handleColorChangeEnd = useCallback(
    (hex: string) => {
      const before = fillBeforeRef.current ?? fill;
      fillBeforeRef.current = null;
      commitFill({ ...before, color: hex }, before);
    },
    [commitFill, fill]
  );

  const handleStyleChange = useCallback(
    ({ value }: SelectValueChangeDetails) => {
      const style = value[0] as CanvasMaskFillContract['style'] | undefined;
      if (style && style !== fill.style) {
        commitFill({ ...fill, style }, fill);
      }
    },
    [commitFill, fill]
  );

  const handleNoiseChange = useCallback(
    ({ value }: SliderValueChangeDetails) => {
      const next = value[0];
      if (next === undefined || !Number.isFinite(next)) {
        return;
      }
      if (
        !applyStructuralPreview(engine, {
          config: noiseConfig(next),
          id: layer.id,
          type: 'updateCanvasLayerConfig',
        })
      ) {
        return;
      }
      noiseBeforeRef.current ??= { value: layer.noiseLevel };
    },
    [engine, layer]
  );

  const handleNoiseChangeEnd = useCallback(
    ({ value }: SliderValueChangeDetails) => {
      const next = value[0];
      const before = noiseBeforeRef.current ? noiseBeforeRef.current.value : layer.noiseLevel;
      noiseBeforeRef.current = null;
      if (next === undefined || !Number.isFinite(next)) {
        return;
      }
      commitPrepared(t('widgets.layers.maskFill.noiseLevel'), (model) =>
        model.prepare({ before: noiseConfig(before), config: noiseConfig(next), id: layer.id, type: 'patch-config' })
      );
    },
    [commitPrepared, layer.id, layer.noiseLevel, t]
  );

  const handleDenoiseChange = useCallback(
    ({ value }: SliderValueChangeDetails) => {
      const next = value[0];
      if (next === undefined || !Number.isFinite(next)) {
        return;
      }
      if (
        !applyStructuralPreview(engine, {
          config: denoiseConfig(next),
          id: layer.id,
          type: 'updateCanvasLayerConfig',
        })
      ) {
        return;
      }
      denoiseBeforeRef.current ??= { value: layer.denoiseLimit };
    },
    [engine, layer]
  );

  const handleDenoiseChangeEnd = useCallback(
    ({ value }: SliderValueChangeDetails) => {
      const next = value[0];
      const before = denoiseBeforeRef.current ? denoiseBeforeRef.current.value : layer.denoiseLimit;
      denoiseBeforeRef.current = null;
      if (next === undefined || !Number.isFinite(next)) {
        return;
      }
      commitPrepared(t('widgets.layers.maskFill.denoiseLimit'), (model) =>
        model.prepare({
          before: denoiseConfig(before),
          config: denoiseConfig(next),
          id: layer.id,
          type: 'patch-config',
        })
      );
    },
    [commitPrepared, layer.denoiseLimit, layer.id, t]
  );

  const handleInvert = useCallback(() => {
    engine?.layers.invertMask(layer.id);
  }, [engine, layer.id]);

  const styleValue = useMemo(() => [fill.style], [fill.style]);
  const colorAria = t('widgets.layers.maskFill.color');
  const noiseValue = useMemo(() => [noiseLevel], [noiseLevel]);
  const denoiseValue = useMemo(() => [denoiseLimit], [denoiseLimit]);
  const noiseAria = useMemo(() => [t('widgets.layers.maskFill.noiseLevel')], [t]);
  const denoiseAria = useMemo(() => [t('widgets.layers.maskFill.denoiseLimit')], [t]);

  return (
    <Stack gap="2">
      <HStack gap="2">
        <Field flexShrink="0" label={t('widgets.layers.maskFill.color')}>
          <ColorPicker
            aria-label={colorAria}
            value={fill.color}
            onValueChange={handleColorChange}
            onValueChangeEnd={handleColorChangeEnd}
          />
        </Field>
        <Field flex="1" label={t('widgets.layers.maskFill.style')} minW="0">
          <Select
            aria-label={t('widgets.layers.maskFill.style')}
            collection={styleCollection}
            positioning={SELECT_POSITIONING}
            size="xs"
            value={styleValue}
            valueText={t(`widgets.layers.maskFill.styles.${fill.style}`)}
            onValueChange={handleStyleChange}
          />
        </Field>
      </HStack>
      <Field label={t('widgets.layers.maskFill.noiseLevel')}>
        <Slider
          aria-label={noiseAria}
          formatValue={formatUnitPercent}
          max={1}
          min={0}
          size="sm"
          step={0.01}
          value={noiseValue}
          withThumbTooltip
          onValueChange={handleNoiseChange}
          onValueChangeEnd={handleNoiseChangeEnd}
        />
      </Field>
      <Field label={t('widgets.layers.maskFill.denoiseLimit')}>
        <Slider
          aria-label={denoiseAria}
          formatValue={formatUnitPercent}
          max={1}
          min={0}
          size="sm"
          step={0.01}
          value={denoiseValue}
          withThumbTooltip
          onValueChange={handleDenoiseChange}
          onValueChangeEnd={handleDenoiseChangeEnd}
        />
      </Field>
      <Button disabled={!engine} size="xs" variant="outline" onClick={handleInvert}>
        {t('widgets.layers.maskFill.invert')}
      </Button>
    </Stack>
  );
};

const SELECT_POSITIONING = { placement: 'bottom-end', sameWidth: false } as const;
