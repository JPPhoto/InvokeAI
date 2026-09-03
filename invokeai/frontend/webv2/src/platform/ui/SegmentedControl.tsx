import type { ReactNode } from 'react';

import { SegmentGroup } from '@chakra-ui/react';
import { useCallback } from 'react';

// Axe measures the checked label against the item's own background, not the
// moving indicator sibling painted behind it, so the item carries the fill too.
const ACCENT_CHECKED_ITEM_STYLES = { bg: 'accent.solid', color: 'accent.contrast' } as const;
const PILL_CHECKED_ITEM_STYLES = { bg: 'bg.emphasized', color: 'fg' } as const;

// The layers panes' pill look: borderless track, neutral emphasized fill.
const PILL_ROOT_CSS = {
  '--segment-indicator-bg': 'colors.bg.emphasized',
  '--segment-radius': 'radii.md',
  borderWidth: '0',
} as const;
// A translucent hover so it reads on panel and popover surfaces alike.
const PILL_ITEM_CSS = {
  fontWeight: '600',
  _hover: { '&:not([data-state=checked])': { bg: 'bg.emphasized/50' } },
} as const;

export interface SegmentedControlOption {
  disabled?: boolean;
  label: ReactNode;
  value: string;
}

export interface SegmentedControlProps extends Omit<SegmentGroup.RootProps, 'onChange' | 'onValueChange' | 'value'> {
  ariaLabel?: string;
  disabled?: boolean;
  /** Default true: the control fills its container, split into equal segments. */
  isFullWidth?: boolean;
  onChange: (value: string) => void;
  options: readonly SegmentedControlOption[];
  value: string | null;
  /** `accent`: bordered track with the accent fill. `pill`: the layers panes' neutral pill tabs. */
  variant?: 'accent' | 'pill';
}

/** The house segmented control: an `xs` group of equal centered segments with `2xs` labels. */
export const SegmentedControl = ({
  ariaLabel,
  disabled,
  isFullWidth = true,
  onChange,
  options,
  value,
  variant = 'accent',
  ...rest
}: SegmentedControlProps) => {
  const handleValueChange = useCallback(
    ({ value: next }: SegmentGroup.ValueChangeDetails) => {
      if (next !== null) {
        onChange(next);
      }
    },
    [onChange]
  );

  const isPill = variant === 'pill';

  return (
    <SegmentGroup.Root
      aria-label={ariaLabel}
      css={isPill ? PILL_ROOT_CSS : undefined}
      disabled={disabled}
      size="xs"
      value={value}
      w={isFullWidth ? 'full' : undefined}
      onValueChange={handleValueChange}
      {...rest}
    >
      <SegmentGroup.Indicator />
      {options.map((option) => (
        <SegmentGroup.Item
          key={option.value}
          css={isPill ? PILL_ITEM_CSS : undefined}
          disabled={option.disabled}
          flex={isFullWidth ? '1' : undefined}
          justifyContent={isFullWidth ? 'center' : undefined}
          minW={isFullWidth ? '0' : undefined}
          value={option.value}
          _checked={isPill ? PILL_CHECKED_ITEM_STYLES : ACCENT_CHECKED_ITEM_STYLES}
        >
          <SegmentGroup.ItemHiddenInput />
          <SegmentGroup.ItemText fontSize={isPill ? 'xs' : '2xs'}>{option.label}</SegmentGroup.ItemText>
        </SegmentGroup.Item>
      ))}
    </SegmentGroup.Root>
  );
};
