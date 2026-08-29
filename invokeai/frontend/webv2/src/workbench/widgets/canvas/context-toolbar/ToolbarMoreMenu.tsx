import type { ReactNode } from 'react';

import { Flex, Popover, Portal, Stack, Text } from '@chakra-ui/react';
import { IconButton } from '@platform/ui';
import { EllipsisIcon } from 'lucide-react';
import { useCallback, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { TOOLBAR_GAP_PX, TOOLBAR_REGION_WIDTH_PX } from './toolbarLayout';

const POSITIONING = { placement: 'bottom-end' } as const;

/** One labelled row of the More menu; a displaced region or the tool's secondary controls. */
export const ToolbarMoreSection = ({ children, label }: { children: ReactNode; label: string }) => {
  const headingId = useId();
  return (
    <Stack aria-labelledby={headingId} gap="1" role="group">
      <Text color="fg.muted" fontSize="2xs" fontWeight="medium" id={headingId} textTransform="uppercase">
        {label}
      </Text>
      <Flex align="center" gap="2" minW="0" w="full">
        {children}
      </Flex>
    </Stack>
  );
};

/**
 * The one overflow for everything the bar cannot show at its width: displaced
 * regions first, in bar order, then the tool's or operation's secondary
 * controls. Always present so the bar's geometry never depends on whether it
 * has content; disabled when empty or while staging or generation owns the surface.
 */
export const ToolbarMoreMenu = ({
  children,
  disabled = false,
  empty,
}: {
  children?: ReactNode;
  disabled?: boolean;
  empty: boolean;
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const onOpenChange = useCallback(({ open: next }: { open: boolean }) => setOpen(next), []);
  const unavailable = empty || disabled;
  return (
    <Popover.Root
      lazyMount
      open={open && !unavailable}
      positioning={POSITIONING}
      unmountOnExit
      onOpenChange={onOpenChange}
    >
      <Popover.Trigger asChild>
        <IconButton
          aria-label={t('widgets.canvas.toolbar.more')}
          data-region="more"
          disabled={unavailable}
          flexShrink={0}
          ms={`${TOOLBAR_GAP_PX}px`}
          size="xs"
          variant="ghost"
          w={`${TOOLBAR_REGION_WIDTH_PX.more}px`}
        >
          <EllipsisIcon />
        </IconButton>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content aria-label={t('widgets.canvas.toolbar.more')} w="22rem">
            <Popover.Body p="3">
              <Stack gap="3">{children}</Stack>
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
};
