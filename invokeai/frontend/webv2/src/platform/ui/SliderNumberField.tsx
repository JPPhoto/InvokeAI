import type { SliderMark } from '@platform/ui/Slider';

import { HStack, NumberInput } from '@chakra-ui/react';
import { Slider } from '@platform/ui/Slider';
import { memo, useCallback, useMemo } from 'react';

type SliderNumberFieldProps = {
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  step: number;
  marks?: SliderMark[];
  /** Looser clamps for typed values (slider bounds apply otherwise). */
  numberInputMin?: number;
  numberInputMax?: number;
  numberInputStep?: number;
  disabled?: boolean;
  formatValue?: (value: number) => string;
  onChange: (value: number) => void;
};

/**
 * Slider + number input combo for numeric parameters. The slider covers the
 * practical range; the input accepts values beyond it when the numberInput
 * bounds are looser. Debouncing stays with the caller. Label, hint, and
 * validation messaging are the caller's job (compose with `Field`) — this
 * component only owns the slider/input pairing. Parameter rows in the
 * Generate/Upscale widgets use `ScrubberField` instead.
 */
export const SliderNumberField = memo(function SliderNumberField({
  ariaLabel,
  disabled,
  formatValue,
  marks,
  max,
  min,
  numberInputMax,
  numberInputMin,
  numberInputStep,
  onChange,
  step,
  value,
}: SliderNumberFieldProps) {
  const sliderAriaLabel = useMemo(() => [ariaLabel], [ariaLabel]);
  // Typed values may exceed the slider's own range (the number input has its own,
  // looser bounds via numberInputMin/Max); the thumb clamps to stay on the track
  // instead of rendering off it, while the input keeps showing the typed value.
  const sliderValue = useMemo(() => [Math.min(max, Math.max(min, value))], [max, min, value]);
  const handleSliderChange = useCallback(
    ({ value: values }: { value: number[] }) => {
      const next = values[0];

      if (typeof next === 'number' && Number.isFinite(next)) {
        onChange(next);
      }
    },
    [onChange]
  );
  const handleNumberChange = useCallback(
    ({ valueAsNumber }: NumberInput.ValueChangeDetails) => {
      if (Number.isFinite(valueAsNumber)) {
        onChange(valueAsNumber);
      }
    },
    [onChange]
  );

  return (
    <HStack gap="2" w="full">
      <Slider
        aria-label={sliderAriaLabel}
        disabled={disabled}
        flex="1"
        formatValue={formatValue}
        marks={marks}
        max={max}
        min={min}
        minW="0"
        size="sm"
        step={step}
        value={sliderValue}
        onValueChange={handleSliderChange}
      />
      <NumberInput.Root
        disabled={disabled}
        flexShrink="0"
        max={numberInputMax ?? max}
        min={numberInputMin ?? min}
        size="xs"
        step={numberInputStep ?? step}
        value={String(value)}
        w="20"
        onValueChange={handleNumberChange}
      >
        <NumberInput.Input aria-label={ariaLabel} fontVariantNumeric="tabular-nums" />
      </NumberInput.Root>
    </HStack>
  );
});
