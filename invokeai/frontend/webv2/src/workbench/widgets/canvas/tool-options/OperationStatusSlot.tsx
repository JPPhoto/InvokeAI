import type { CSSProperties } from 'react';

import { Flex, HStack, IconButton, Spinner, Text, VisuallyHidden } from '@chakra-ui/react';
import { Tooltip } from '@platform/ui';
import { CircleAlertIcon, InfoIcon } from 'lucide-react';

const ERROR_CLAMP_STYLE: CSSProperties = {
  display: '-webkit-box',
  overflow: 'hidden',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
};

/**
 * The always-mounted status slot shared by the canvas operation bars: reserves
 * its width so status/error text appearing never shifts the surrounding
 * controls, and keeps the polite live region in the tree before content
 * arrives so announcements are reliable.
 */
export const OperationStatusSlot = ({
  errorDetail,
  errorText,
  isBusy,
  minW = '8rem',
  statusText,
  technicalDetailsLabel,
}: {
  errorDetail: string | null;
  errorText: string | null;
  isBusy: boolean;
  minW?: string;
  statusText: string;
  technicalDetailsLabel: string;
}) => {
  const detail = errorDetail?.trim();
  return (
    <Flex
      align="center"
      color={errorText ? 'fg.error' : 'fg.muted'}
      flex="0 1 auto"
      fontSize="xs"
      gap="1"
      maxW="16rem"
      minW={minW}
    >
      {errorText ? (
        <>
          <span aria-live="assertive" role="alert" style={ERROR_CLAMP_STYLE}>
            {errorText}
          </span>
          {detail && detail !== errorText ? (
            <Tooltip content={detail}>
              <IconButton aria-label={technicalDetailsLabel} flexShrink="0" size="xs" tabIndex={0} variant="ghost">
                <InfoIcon />
              </IconButton>
            </Tooltip>
          ) : null}
        </>
      ) : (
        <Flex align="center" aria-live="polite" gap="2" minW="0" role="status">
          {isBusy ? (
            <>
              <Spinner flexShrink="0" size="xs" />
              <span>{statusText}</span>
            </>
          ) : null}
        </Flex>
      )}
    </Flex>
  );
};

interface OperationStatusChipProps {
  compact: boolean;
  errorDetail: string | null;
  errorText: string | null;
  isBusy: boolean;
  /** The source layer, named for assistive tech and the tooltip. */
  sourceLabel: string;
  statusText: string;
  technicalDetailsLabel: string;
  title: string;
}

/**
 * The toolbar's status chip for a running operation: title plus the live
 * status slot, or at compact widths a single icon (spinner, error, info) whose
 * tooltip carries the text while the live region stays mounted for announcements.
 */
export const OperationStatusChip = ({
  compact,
  errorDetail,
  errorText,
  isBusy,
  sourceLabel,
  statusText,
  technicalDetailsLabel,
  title,
}: OperationStatusChipProps) => {
  const slot = (
    <OperationStatusSlot
      errorDetail={errorDetail}
      errorText={errorText}
      isBusy={isBusy}
      minW="0"
      statusText={statusText}
      technicalDetailsLabel={technicalDetailsLabel}
    />
  );
  if (compact) {
    return (
      <Tooltip content={`${title} · ${errorText ?? (isBusy ? statusText : sourceLabel)}`}>
        <Flex align="center" boxSize="8" color={errorText ? 'fg.error' : 'fg.muted'} justify="center">
          {errorText ? <CircleAlertIcon size={16} /> : isBusy ? <Spinner size="xs" /> : <InfoIcon size={16} />}
          <VisuallyHidden>
            {title}
            {slot}
          </VisuallyHidden>
        </Flex>
      </Tooltip>
    );
  }
  return (
    <HStack gap="1" minW="0">
      <Tooltip content={sourceLabel}>
        <Text flexShrink={0} fontSize="xs" fontWeight="semibold" minW="0" truncate>
          {title}
          <VisuallyHidden>{sourceLabel}</VisuallyHidden>
        </Text>
      </Tooltip>
      {slot}
    </HStack>
  );
};
