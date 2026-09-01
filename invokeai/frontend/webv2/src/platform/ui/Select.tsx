import type {
  CollectionItem,
  SelectContentProps,
  SelectIndicatorGroupProps,
  SelectPositionerProps,
  SelectRootProps,
  SelectTriggerProps,
  SelectValueTextProps,
} from '@chakra-ui/react';
import type { Key, ReactNode } from 'react';

import { Portal, Select as ChakraSelect, useFieldContext } from '@chakra-ui/react';

const getDefaultItemKey = <T extends CollectionItem>(item: T, index: number): Key => {
  const keyedItem = item as { id?: Key; value?: Key };

  return keyedItem.value ?? keyedItem.id ?? index;
};

const renderDefaultItem = <T extends CollectionItem>(item: T): ReactNode => {
  const labelledItem = item as { label?: ReactNode; value?: ReactNode };

  return labelledItem.label ?? labelledItem.value;
};

export interface SelectProps<T extends CollectionItem> extends Omit<SelectRootProps<T>, 'children'> {
  contentProps?: SelectContentProps;
  getItemKey?: (item: T, index: number) => Key;
  indicatorGroupProps?: SelectIndicatorGroupProps;
  itemIndicator?: boolean;
  portalled?: boolean;
  positionerProps?: SelectPositionerProps;
  renderItem?: (item: T) => ReactNode;
  triggerProps?: SelectTriggerProps;
  valueText?: ReactNode;
  valueTextProps?: SelectValueTextProps;
}

/** Workbench Select: Chakra's custom Select with the standard trigger, portal, and item markup pre-wired. */
export const Select = <T extends CollectionItem>({
  'aria-label': ariaLabel,
  collection,
  contentProps,
  getItemKey = getDefaultItemKey,
  indicatorGroupProps,
  itemIndicator = true,
  portalled = true,
  positionerProps,
  renderItem = renderDefaultItem,
  triggerProps,
  valueText,
  valueTextProps,
  ...rootProps
}: SelectProps<T>) => {
  // Inside a Field the machine adopts the field's label id, so rendering our
  // own Label part there would duplicate that id; the field's visible label
  // already names the trigger.
  const field = useFieldContext();
  return (
    <ChakraSelect.Root collection={collection} {...rootProps}>
      {/* A real (visually hidden) Label part: the machine's trigger always points
        its aria-labelledby at this id, so a bare aria-label must materialize it —
        left on the Root it lands on a div, which ARIA prohibits. */}
      {ariaLabel && !field ? <ChakraSelect.Label srOnly>{ariaLabel}</ChakraSelect.Label> : null}
      <ChakraSelect.HiddenSelect />
      <ChakraSelect.Control>
        <ChakraSelect.Trigger {...triggerProps}>
          <ChakraSelect.ValueText {...valueTextProps}>{valueText}</ChakraSelect.ValueText>
        </ChakraSelect.Trigger>
        <ChakraSelect.IndicatorGroup {...indicatorGroupProps}>
          <ChakraSelect.Indicator />
        </ChakraSelect.IndicatorGroup>
      </ChakraSelect.Control>
      <Portal disabled={!portalled}>
        <ChakraSelect.Positioner {...positionerProps}>
          <ChakraSelect.Content {...contentProps}>
            {collection.items.map((item, index) => (
              <ChakraSelect.Item key={getItemKey(item, index)} item={item}>
                <ChakraSelect.ItemText>{renderItem(item)}</ChakraSelect.ItemText>
                {itemIndicator ? <ChakraSelect.ItemIndicator /> : null}
              </ChakraSelect.Item>
            ))}
          </ChakraSelect.Content>
        </ChakraSelect.Positioner>
      </Portal>
    </ChakraSelect.Root>
  );
};
