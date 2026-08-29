import type { ReactNode, Ref } from 'react';

import { Flex, Stack, Text } from '@chakra-ui/react';
import { FieldLabel } from '@platform/ui/Field';

/** A headed group of rows in the Properties widget: Operation, Tool, Layer. */
export const PropertiesSection = ({
  children,
  disabled = false,
  ref,
  subtitle,
  title,
}: {
  children: ReactNode;
  /** The surface is busy elsewhere (staging, generation, an operation): the rows stay in place but cannot act. */
  disabled?: boolean;
  ref?: Ref<HTMLDivElement>;
  subtitle?: string;
  title: string;
}) => {
  return (
    <Stack
      ref={ref}
      aria-label={title}
      borderBottomWidth="1px"
      borderColor="border.subtle"
      gap="2"
      inert={disabled || undefined}
      opacity={disabled ? 0.5 : 1}
      px="3"
      py="2.5"
      role="group"
    >
      <Flex align="baseline" gap="2" minW="0">
        <FieldLabel>{title}</FieldLabel>
        {subtitle ? (
          <Text color="fg.muted" fontSize="xs" minW="0" truncate>
            {subtitle}
          </Text>
        ) : null}
      </Flex>
      {children}
    </Stack>
  );
};

/** One labelled row: a fixed label column and the controls packed after it, wrapping when the dock is narrow. */
export const PropertiesRow = ({ children, label }: { children: ReactNode; label: string }) => (
  <Flex align="flex-start" gap="2" minW="0">
    <Flex align="center" flexShrink={0} minH="8" w="20">
      <Text color="fg.muted" fontSize="xs">
        {label}
      </Text>
    </Flex>
    <Flex align="center" flex="1" flexWrap="wrap" gap="2" minH="8" minW="0">
      {children}
    </Flex>
  </Flex>
);
