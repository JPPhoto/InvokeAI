import type { NumberInput as ChakraNumberInput } from '@chakra-ui/react';
import type { BrushOptions as BrushOptionsState } from '@workbench/canvas-engine/api';
import type {
  ToolbarRegionProps,
  ToolPresentationAdapter,
} from '@workbench/widgets/canvas/context-toolbar/toolbarContracts';
import type { KeyboardEvent } from 'react';

import { HStack } from '@chakra-ui/react';
import { ColorPicker, ToggleIconButton } from '@platform/ui';
import { MAX_BRUSH_SIZE, MIN_BRUSH_SIZE } from '@workbench/canvas-engine/api';
import {
  ToolbarNumberField,
  ToolbarSlider,
  useNumberCommit,
} from '@workbench/widgets/canvas/context-toolbar/ToolbarPrimitives';
import { useBrushOptions } from '@workbench/widgets/canvas/engineStoreHooks';
import { useColorSampler } from '@workbench/widgets/canvas/useColorSampler';
import { BrushIcon, DropletIcon, PenLineIcon } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export const BRUSH_SIZE_SLIDER_MAX_SIZE = 600;
export const BRUSH_SIZE_SLIDER_MIN = 0;
export const BRUSH_SIZE_SLIDER_MAX = 10_000;
/** Fine pointer resolution; keyboard changes use human-sized pixel increments below. */
export const BRUSH_SIZE_SLIDER_STEP = 1;

const LOG_SIZE_RANGE = Math.log(BRUSH_SIZE_SLIDER_MAX_SIZE / MIN_BRUSH_SIZE);

export const clampBrushSize = (value: number): number =>
  Math.max(MIN_BRUSH_SIZE, Math.min(MAX_BRUSH_SIZE, Math.round(value * 100) / 100));

export const brushSizeToSliderPosition = (size: number): number => {
  const clamped = Math.max(MIN_BRUSH_SIZE, Math.min(BRUSH_SIZE_SLIDER_MAX_SIZE, size));
  return (Math.log(clamped / MIN_BRUSH_SIZE) / LOG_SIZE_RANGE) * BRUSH_SIZE_SLIDER_MAX;
};

export const sliderPositionToBrushSize = (position: number): number => {
  const clamped = Math.max(BRUSH_SIZE_SLIDER_MIN, Math.min(BRUSH_SIZE_SLIDER_MAX, position));
  return clampBrushSize(MIN_BRUSH_SIZE * Math.exp((clamped / BRUSH_SIZE_SLIDER_MAX) * LOG_SIZE_RANGE));
};

export const formatBrushSize = (size: number): string =>
  clampBrushSize(size)
    .toFixed(2)
    .replace(/\.?0+$/, '');

export const getBrushSizeKeyboardStep = (size: number, direction: -1 | 1): number => {
  if (size < 1 || (direction < 0 && size === 1)) {
    return 0.01;
  }
  if (size < 10 || (direction < 0 && size === 10)) {
    return 0.1;
  }
  if (size < 100 || (direction < 0 && size === 100)) {
    return 1;
  }
  return 10;
};

/** Logarithmic size slider plus an exact numeric field, shared by the brush and eraser. */
export const PaintSizeControl = ({
  label,
  setSize,
  size,
}: {
  label: string;
  setSize: (size: number) => void;
  size: number;
}) => {
  const numberValue = formatBrushSize(size);
  const formatPx = useCallback(() => `${numberValue}px`, [numberValue]);
  const onSlider = useCallback((position: number) => setSize(sliderPositionToBrushSize(position)), [setSize]);
  const onCommit = useNumberCommit((value) => setSize(clampBrushSize(value)));
  const onSliderKeyDownCapture = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      const direction = event.key === 'ArrowUp' || event.key === 'ArrowRight' || event.key === 'PageUp' ? 1 : -1;
      if (
        event.key !== 'ArrowUp' &&
        event.key !== 'ArrowRight' &&
        event.key !== 'ArrowDown' &&
        event.key !== 'ArrowLeft' &&
        event.key !== 'PageUp' &&
        event.key !== 'PageDown'
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (size > BRUSH_SIZE_SLIDER_MAX_SIZE && direction > 0) {
        return;
      }
      const multiplier = event.key === 'PageUp' || event.key === 'PageDown' ? 10 : 1;
      const sliderSize = Math.min(size, BRUSH_SIZE_SLIDER_MAX_SIZE);
      setSize(
        Math.min(
          BRUSH_SIZE_SLIDER_MAX_SIZE,
          clampBrushSize(sliderSize + direction * multiplier * getBrushSizeKeyboardStep(sliderSize, direction))
        )
      );
    },
    [setSize, size]
  );

  return (
    <>
      <ToolbarSlider
        aria-label={label}
        formatValue={formatPx}
        getAriaValueText={formatPx}
        max={BRUSH_SIZE_SLIDER_MAX}
        min={BRUSH_SIZE_SLIDER_MIN}
        step={BRUSH_SIZE_SLIDER_STEP}
        value={brushSizeToSliderPosition(size)}
        onKeyDownCapture={onSliderKeyDownCapture}
        onValueChange={onSlider}
      />
      <ToolbarNumberField
        aria-label={label}
        max={MAX_BRUSH_SIZE}
        min={MIN_BRUSH_SIZE}
        step={0.1}
        suffix="px"
        value={numberValue}
        onValueCommit={onCommit}
      />
    </>
  );
};

const formatPercent = (value: number): string => `${Math.round(value)}%`;

/** Opacity slider plus a percent field, shared by the brush and eraser. */
export const PaintOpacityControl = ({
  opacity,
  setOpacity,
}: {
  opacity: number;
  setOpacity: (opacity: number) => void;
}) => {
  const { t } = useTranslation();
  const label = t('widgets.canvas.toolOptions.opacity');
  const percent = Math.round(opacity * 100);
  const onSlider = useCallback((value: number) => setOpacity(value / 100), [setOpacity]);
  const onNumber = useCallback(
    ({ valueAsNumber }: ChakraNumberInput.ValueChangeDetails) => {
      if (Number.isFinite(valueAsNumber)) {
        setOpacity(Math.max(0, Math.min(100, valueAsNumber)) / 100);
      }
    },
    [setOpacity]
  );
  return (
    <>
      <ToolbarSlider
        aria-label={label}
        formatValue={formatPercent}
        max={100}
        min={0}
        value={percent}
        onValueChange={onSlider}
      />
      <ToolbarNumberField
        aria-label={label}
        max={100}
        min={0}
        suffix="%"
        value={String(percent)}
        onValueChange={onNumber}
      />
    </>
  );
};

const useBrushPatch = (engine: ToolbarRegionProps['engine']) => {
  const options = useBrushOptions(engine);
  const patch = useCallback(
    (changes: Partial<BrushOptionsState>) => engine.interaction.set('brushOptions', { ...options, ...changes }),
    [engine, options]
  );
  return [options, patch] as const;
};

const BrushSize = ({ engine }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const [options, set] = useBrushPatch(engine);
  const setSize = useCallback((size: number) => set({ size: clampBrushSize(size) }), [set]);
  return <PaintSizeControl label={t('widgets.canvas.toolOptions.brushSize')} setSize={setSize} size={options.size} />;
};

const BrushOpacity = ({ engine }: ToolbarRegionProps) => {
  const [options, set] = useBrushPatch(engine);
  const setOpacity = useCallback((opacity: number) => set({ opacity }), [set]);
  return <PaintOpacityControl opacity={options.opacity} setOpacity={setOpacity} />;
};

const BrushColor = ({ engine }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const [options, set] = useBrushPatch(engine);
  const onColorChange = useCallback((color: string) => set({ color }), [set]);
  const sampleColor = useColorSampler(engine);
  return (
    <ColorPicker
      aria-label={t('widgets.canvas.toolOptions.brushColor')}
      value={options.color}
      onSampleColor={sampleColor}
      onValueChange={onColorChange}
    />
  );
};

/** Width and opacity are separate pressure responses (opacity also costs a scratch refill per frame). */
const BrushPressure = ({ engine }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const [options, set] = useBrushPatch(engine);
  const onWidth = useCallback((pressureAffectsWidth: boolean) => set({ pressureAffectsWidth }), [set]);
  const onOpacity = useCallback((pressureAffectsOpacity: boolean) => set({ pressureAffectsOpacity }), [set]);
  return (
    <HStack gap="1">
      <ToggleIconButton
        checked={options.pressureAffectsWidth}
        icon={PenLineIcon}
        label={t('widgets.canvas.toolOptions.pressureAffectsWidth')}
        onCheckedChange={onWidth}
      />
      <ToggleIconButton
        checked={options.pressureAffectsOpacity}
        icon={DropletIcon}
        label={t('widgets.canvas.toolOptions.pressureAffectsOpacity')}
        onCheckedChange={onOpacity}
      />
    </HStack>
  );
};

export const brushAdapter: ToolPresentationAdapter = {
  color: BrushColor,
  geometry: BrushSize,
  icon: BrushIcon,
  id: 'brush',
  intensity: BrushOpacity,
  more: BrushPressure,
  paintsLeaf: true,
  primary: 'geometry',
};
