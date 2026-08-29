import type { NumberInput as ChakraNumberInput, SliderValueChangeDetails } from '@chakra-ui/react';
import type { KeyboardEvent, ReactNode } from 'react';

import { Box, Flex, NumberInput, Text } from '@chakra-ui/react';
import { Button, IconButton, Slider } from '@platform/ui';
import { CheckIcon, XIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { TOOLBAR_NUMBER_FIELD_WIDTH_PX } from './toolbarLayout';

interface ToolbarNumberFieldProps {
  'aria-label': string;
  disabled?: boolean;
  /** Short prefix drawn inside the field (X, Y, W, H). */
  label?: string;
  max?: number;
  min?: number;
  step?: number;
  suffix?: string;
  value: string;
  /** Live mode: every keystroke reaches the owner (session previews). */
  onValueChange?: (details: ChakraNumberInput.ValueChangeDetails) => void;
  /** Commit mode: the field keeps a draft and hands it over on blur or Enter (document edits). */
  onValueCommit?: (details: ChakraNumberInput.ValueChangeDetails) => void;
}

const FieldAffix = ({ children, disabled, side }: { children: string; disabled?: boolean; side: 'start' | 'end' }) => (
  <Text
    aria-hidden
    color={disabled ? 'fg.subtle' : 'fg.muted'}
    fontSize="2xs"
    fontWeight={side === 'start' ? 'medium' : undefined}
    insetEnd={side === 'end' ? '1.5' : undefined}
    insetStart={side === 'start' ? '1.5' : undefined}
    lineHeight="1"
    pointerEvents="none"
    position="absolute"
    top="50%"
    transform="translateY(-50%)"
    zIndex="1"
  >
    {children}
  </Text>
);

/**
 * A fixed-width numeric field with tabular figures. In commit mode a draft
 * survives typing and only the accepted value is shown afterwards, so a
 * clamped or rounded commit never leaves the field disagreeing with its owner
 * and never remounts (focus stays where it was).
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
  const onDraftChange = useCallback(({ value: next }: ChakraNumberInput.ValueChangeDetails) => setDraft(next), []);
  const onDraftCommit = useCallback(
    (details: ChakraNumberInput.ValueChangeDetails) => {
      setDraft(null);
      onValueCommit?.(details);
    },
    [onValueCommit]
  );
  const live = onValueChange !== undefined;
  return (
    <Box flexShrink={0} position="relative" w={`${TOOLBAR_NUMBER_FIELD_WIDTH_PX}px`}>
      {label ? (
        <FieldAffix disabled={disabled} side="start">
          {label}
        </FieldAffix>
      ) : null}
      {suffix ? (
        <FieldAffix disabled={disabled} side="end">
          {suffix}
        </FieldAffix>
      ) : null}
      <NumberInput.Root
        disabled={disabled}
        max={max}
        min={min}
        size="xs"
        step={step}
        value={live ? value : (draft ?? value)}
        w="full"
        onValueChange={live ? onValueChange : onDraftChange}
        onValueCommit={live ? undefined : onDraftCommit}
      >
        <NumberInput.Input
          aria-label={ariaLabel}
          fontSize="xs"
          fontVariantNumeric="tabular-nums"
          pe={suffix ? '3.5' : '1.5'}
          ps={label ? '3.5' : '1.5'}
          textAlign="end"
        />
      </NumberInput.Root>
    </Box>
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

/**
 * The status region's fixed frame: a truncating chip, then Apply and Cancel in
 * place at every width (icon-only when compact, disabled when nothing is pending).
 */
export const ToolbarStatus = ({
  applyDisabled = true,
  applyLoading = false,
  cancelDisabled = true,
  children,
  compact,
  onApply,
  onCancel,
}: {
  applyDisabled?: boolean;
  applyLoading?: boolean;
  cancelDisabled?: boolean;
  children?: ReactNode;
  compact: boolean;
  onApply?: () => void;
  onCancel?: () => void;
}) => {
  const { t } = useTranslation();
  const applyLabel = t('common.apply');
  const cancelLabel = t('common.cancel');
  return (
    <Flex align="center" gap="1" h="full" minW="0" w="full">
      <Box flex="1" minW="0" overflow="hidden" whiteSpace="nowrap">
        {children}
      </Box>
      {compact ? (
        <IconButton
          aria-label={applyLabel}
          data-toolbar-action="apply"
          disabled={applyDisabled}
          flexShrink={0}
          loading={applyLoading}
          size="xs"
          variant="solid"
          onClick={onApply}
        >
          <CheckIcon />
        </IconButton>
      ) : (
        <Button
          data-toolbar-action="apply"
          disabled={applyDisabled}
          flexShrink={0}
          loading={applyLoading}
          size="xs"
          variant="solid"
          w="14"
          onClick={onApply}
        >
          {applyLabel}
        </Button>
      )}
      {compact ? (
        <IconButton
          aria-label={cancelLabel}
          data-toolbar-action="cancel"
          disabled={cancelDisabled}
          flexShrink={0}
          size="xs"
          variant="ghost"
          onClick={onCancel}
        >
          <XIcon />
        </IconButton>
      ) : (
        <Button
          data-toolbar-action="cancel"
          disabled={cancelDisabled}
          flexShrink={0}
          size="xs"
          variant="ghost"
          w="16"
          onClick={onCancel}
        >
          {cancelLabel}
        </Button>
      )}
    </Flex>
  );
};

/** Muted, truncating guidance for tools and states without a control to show. */
export const ToolbarHint = ({ children }: { children: string }) => (
  <Text color="fg.muted" data-toolbar-hint="" fontSize="xs" minW="0" title={children} truncate>
    {children}
  </Text>
);
