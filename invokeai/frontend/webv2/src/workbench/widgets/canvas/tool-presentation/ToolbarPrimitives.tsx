/* oxlint-disable react-perf/jsx-no-jsx-as-prop */
import type { NumberInput as ChakraNumberInput, SliderValueChangeDetails } from '@chakra-ui/react';
import type { KeyboardEvent, ReactNode } from 'react';

import { Box, Flex, Icon, InputGroup, NumberInput, Text } from '@chakra-ui/react';
import { Button } from '@platform/ui/Button';
import { Slider } from '@platform/ui/Slider';
import { MoveHorizontalIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Width of every numeric field, so X / Y / W / H line up across tools; fits "-1234.56" beside its affixes. */
const TOOLBAR_NUMBER_FIELD_WIDTH_PX = 80;

interface ToolbarNumberFieldProps {
  'aria-label': string;
  disabled?: boolean;
  /** Short prefix drawn inside the field (X, Y, W, H); it doubles as the scrub handle. */
  label?: string;
  max?: number;
  min?: number;
  step?: number;
  suffix?: string;
  value: string;
  /** Live mode: every keystroke reaches the owner (session previews). */
  onValueChange?: (details: ChakraNumberInput.ValueChangeDetails) => void;
  /** Commit mode: the field keeps a draft and hands it over on blur, Enter or the end of a scrub (document edits). */
  onValueCommit?: (details: ChakraNumberInput.ValueChangeDetails) => void;
}

const AFFIX_PROPS = { color: 'fg.muted', fontSize: '2xs', lineHeight: '1' } as const;
// InputGroup pads the input by `--input-height` (32px at size xs) minus the offset; the text must clear the affix.
const INPUT_HEIGHT_PX = 32;
const AFFIX_CHAR_PX = 6;
const AFFIX_GUTTER_PX = 8;
const affixOffset = (chars: number): string => `${INPUT_HEIGHT_PX - AFFIX_GUTTER_PX - chars * AFFIX_CHAR_PX}px`;
const START_ELEMENT_PROPS = { ...AFFIX_PROPS, fontWeight: 'medium', pointerEvents: 'auto', ps: '1.5' } as const;
const END_ELEMENT_PROPS = { ...AFFIX_PROPS, pe: '1.5', pointerEvents: 'none' } as const;

/**
 * A fixed-width numeric field with tabular figures whose prefix is a scrub
 * handle (drag sideways with the mouse to change the value by `step` per
 * pixel). In commit mode a draft survives typing and scrubbing; the owner
 * hears one value on blur, Enter or pointer-up, and only when something was
 * edited to a different string, so tabbing through fields never commits the
 * rounded display back over a precise value. Only the accepted value shows
 * afterwards, so a clamped commit never leaves the field disagreeing with its owner.
 */
export const ToolbarNumberField = ({
  'aria-label': ariaLabel,
  disabled,
  label,
  max,
  min,
  step,
  suffix,
  value,
  onValueChange,
  onValueCommit,
}: ToolbarNumberFieldProps) => {
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const scrubEnd = useRef<(() => void) | null>(null);
  const onDraftChange = useCallback(({ value: next }: ChakraNumberInput.ValueChangeDetails) => {
    draftRef.current = next;
    setDraft(next);
  }, []);
  const onDraftCommit = useCallback(
    (details: ChakraNumberInput.ValueChangeDetails) => {
      const edited = draftRef.current !== null;
      draftRef.current = null;
      setDraft(null);
      if (edited && details.value !== value) {
        onValueCommit?.(details);
      }
    },
    [onValueCommit, value]
  );
  // The number input commits on blur and Enter only; a scrub ends with the
  // mouse button, so the draft it produced is committed when the button lifts.
  // The listener reads the ref: a release in the same frame as the last move
  // must not commit a draft one step behind.
  const onScrubStart = useCallback(() => {
    scrubEnd.current?.();
    const scrub = new AbortController();
    scrubEnd.current = () => scrub.abort();
    window.addEventListener(
      'mouseup',
      () => {
        scrub.abort();
        scrubEnd.current = null;
        const next = draftRef.current;
        if (next !== null) {
          onDraftCommit({ value: next, valueAsNumber: Number.parseFloat(next) });
        }
      },
      { signal: scrub.signal }
    );
  }, [onDraftCommit]);
  useEffect(() => () => scrubEnd.current?.(), []);
  const live = onValueChange !== undefined;
  return (
    <NumberInput.Root
      disabled={disabled}
      flexShrink={0}
      max={max}
      min={min}
      size="xs"
      step={step}
      value={live ? value : (draft ?? value)}
      w={`${TOOLBAR_NUMBER_FIELD_WIDTH_PX}px`}
      onValueChange={live ? onValueChange : onDraftChange}
      onValueCommit={live ? undefined : onDraftCommit}
    >
      <InputGroup
        endElement={suffix ? <span aria-hidden>{suffix}</span> : undefined}
        endElementProps={END_ELEMENT_PROPS}
        endOffset={suffix ? affixOffset(suffix.length) : undefined}
        startElement={
          <NumberInput.Scrubber aria-hidden onMouseDownCapture={live ? undefined : onScrubStart}>
            {label ?? <Icon as={MoveHorizontalIcon} boxSize="3" />}
          </NumberInput.Scrubber>
        }
        startElementProps={START_ELEMENT_PROPS}
        startOffset={label ? affixOffset(label.length) : affixOffset(2)}
      >
        <NumberInput.Input aria-label={ariaLabel} fontSize="xs" fontVariantNumeric="tabular-nums" textAlign="end" />
      </InputGroup>
    </NumberInput.Root>
  );
};

/** Commit-mode handler: applies a finite number and ignores the rest. */
export const useNumberCommit = (apply: (value: number) => void) =>
  useCallback(
    ({ valueAsNumber }: ChakraNumberInput.ValueChangeDetails) => {
      if (Number.isFinite(valueAsNumber)) {
        apply(valueAsNumber);
      }
    },
    [apply]
  );

interface ToolbarSliderProps {
  'aria-label': string;
  disabled?: boolean;
  formatValue?: (value: number) => string;
  getAriaValueText?: (value: number) => string;
  max: number;
  min: number;
  step?: number;
  value: number;
  onKeyDownCapture?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onValueChange: (value: number) => void;
}

/** A slider that fills its region; pairs with a {@link ToolbarNumberField}. */
export const ToolbarSlider = ({
  'aria-label': ariaLabel,
  disabled,
  formatValue,
  getAriaValueText,
  max,
  min,
  step,
  value,
  onKeyDownCapture,
  onValueChange,
}: ToolbarSliderProps) => {
  const labels = useMemo(() => [ariaLabel], [ariaLabel]);
  const values = useMemo(() => [value], [value]);
  const valueText = useMemo(
    () => (getAriaValueText ? ({ value: current }: { value: number }) => getAriaValueText(current) : undefined),
    [getAriaValueText]
  );
  const handleChange = useCallback(
    ({ value: next }: SliderValueChangeDetails) => {
      const first = next[0];
      if (first !== undefined && Number.isFinite(first)) {
        onValueChange(first);
      }
    },
    [onValueChange]
  );
  return (
    <Slider
      aria-label={labels}
      disabled={disabled}
      flex="1"
      formatValue={formatValue}
      getAriaValueText={valueText}
      max={max}
      min={min}
      minW="0"
      size="sm"
      step={step}
      value={values}
      onKeyDownCapture={onKeyDownCapture}
      onValueChange={handleChange}
    />
  );
};

/** Apply and Cancel for a pending operation, session or float, after whatever the owner shows about it. */
export const ToolbarStatus = ({
  applyDisabled = true,
  applyLoading = false,
  cancelDisabled = true,
  children,
  onApply,
  onCancel,
}: {
  applyDisabled?: boolean;
  applyLoading?: boolean;
  cancelDisabled?: boolean;
  children?: ReactNode;
  onApply?: () => void;
  onCancel?: () => void;
}) => {
  const { t } = useTranslation();
  return (
    <Flex align="center" gap="1" minW="0" w="full">
      <Box flex="1" minW="0" overflow="hidden" whiteSpace="nowrap">
        {children}
      </Box>
      <Button
        data-toolbar-action="apply"
        disabled={applyDisabled}
        flexShrink={0}
        loading={applyLoading}
        size="xs"
        variant="solid"
        onClick={onApply}
      >
        {t('common.apply')}
      </Button>
      <Button
        data-toolbar-action="cancel"
        disabled={cancelDisabled}
        flexShrink={0}
        size="xs"
        variant="ghost"
        onClick={onCancel}
      >
        {t('common.cancel')}
      </Button>
    </Flex>
  );
};

/** Muted guidance for tools and states without a control to show. */
export const ToolbarHint = ({ children }: { children: string }) => (
  <Text color="fg.muted" data-toolbar-hint="" fontSize="xs" minW="0">
    {children}
  </Text>
);
