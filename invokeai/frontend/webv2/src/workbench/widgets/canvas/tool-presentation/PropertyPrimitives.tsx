import type { ReactNode } from 'react';

import { chakra, Grid, Icon, Stack, Switch, Text } from '@chakra-ui/react';
import { ChevronDownIcon } from 'lucide-react';
import { useCallback } from 'react';

import { setPropertyGroupCollapsed, usePropertyGroupCollapsed } from './propertyGroupStore';

const GROUP_HEADER_HOVER = { color: 'fg' } as const;

/**
 * One settings row of a tool property form: a fixed label column, a flexible
 * control cell, and a fixed trailing cell. Grid, not wrapping flex — a slider
 * and its number field are one row at every pane width.
 */
export const PropertyControlRow = ({ children, label }: { children: ReactNode; label: string }) => (
  <Grid alignItems="center" columnGap="2" gridTemplateColumns="4.5rem minmax(0, 1fr) auto" minH="7" w="full">
    <Text color="fg.muted" fontSize="xs" minW="0" truncate>
      {label}
    </Text>
    {children}
  </Grid>
);

/** A labelled on/off row; the label is the switch's own, so the whole row is one click target. */
export const PropertySwitchRow = ({
  checked,
  disabled,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) => {
  const handleChange = useCallback(
    ({ checked: next }: { checked: boolean }) => onCheckedChange(next),
    [onCheckedChange]
  );
  return (
    <Switch.Root
      checked={checked}
      disabled={disabled}
      justifyContent="space-between"
      minH="7"
      size="sm"
      w="full"
      onCheckedChange={handleChange}
    >
      <Switch.Label color="fg.muted" fontSize="xs">
        {label}
      </Switch.Label>
      <Switch.HiddenInput />
      <Switch.Control>
        <Switch.Thumb />
      </Switch.Control>
    </Switch.Root>
  );
};

/**
 * A named group of form rows. A collapsible group renders its label as a
 * disclosure button and remembers the user's choice per group id (an override
 * store; the declared default applies until the user touches it).
 */
export const PropertyGroup = ({
  children,
  collapsible,
  id,
  label,
}: {
  children: ReactNode;
  /** Absent means always open with a plain header. */
  collapsible?: 'open' | 'collapsed';
  id: string;
  label: string;
}) => {
  const collapsed = usePropertyGroupCollapsed(id, collapsible === 'collapsed');
  const onToggle = useCallback(() => setPropertyGroupCollapsed(id, !collapsed), [collapsed, id]);
  const open = !collapsible || !collapsed;
  return (
    <Stack aria-label={label} gap="1" role="group">
      {collapsible ? (
        <chakra.button
          alignItems="center"
          aria-expanded={open}
          color="fg.muted"
          cursor="pointer"
          display="flex"
          gap="1"
          rounded="xs"
          type="button"
          w="fit-content"
          _hover={GROUP_HEADER_HOVER}
          onClick={onToggle}
        >
          <Icon
            as={ChevronDownIcon}
            boxSize="3"
            transform={open ? undefined : 'rotate(-90deg)'}
            transitionDuration="fast"
            transitionProperty="transform"
          />
          <Text fontSize="xs" fontWeight="600">
            {label}
          </Text>
        </chakra.button>
      ) : (
        <Text color="fg.muted" fontSize="xs" fontWeight="600">
          {label}
        </Text>
      )}
      {open ? children : null}
    </Stack>
  );
};
