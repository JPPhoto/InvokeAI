import type { BoxProps } from '@chakra-ui/react';
import type { ReactNode, Ref } from 'react';

import { Box } from '@chakra-ui/react';
import { inputShellInteraction } from '@theme/recipes';

export interface InputShellProps extends BoxProps {
  ref?: Ref<HTMLDivElement>;
  /** Leading adornment (e.g. a search icon), outside the content cell. */
  startElement?: ReactNode;
  /** Trailing adornments (clear/help buttons), outside the content cell. */
  endElement?: ReactNode;
}

/**
 * The themed input's chrome for composite fields whose focusable element lives
 * inside the frame — a transparent input under a rendered mirror, a query
 * chip. Metrics and states match `<Input size="xs">`, keyed on focus-within so
 * the frame responds to the inner control; `aria-invalid` on the shell drives
 * the invalid border like the input's own.
 */
export const InputShell = ({ children, endElement, ref, startElement, ...boxProps }: InputShellProps) => (
  <Box
    ref={ref}
    alignItems="center"
    borderColor="border"
    borderRadius="control"
    borderWidth="1px"
    css={inputShellInteraction}
    display="flex"
    gap="1.5"
    h="8"
    minW="0"
    px="2"
    textStyle="xs"
    w="full"
    {...boxProps}
  >
    {startElement}
    <Box alignItems="center" display="flex" flex="1" minW="0" position="relative">
      {children}
    </Box>
    {endElement}
  </Box>
);
