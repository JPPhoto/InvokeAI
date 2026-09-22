import type { ReactNode } from 'react';

import { HStack, Stack, Text } from '@chakra-ui/react';
import { useTranslation } from 'react-i18next';

/** The opaque island a multi-session tile's status footer floats in over its stage. */
export const PreviewFooterIsland = ({ children }: { children: ReactNode }) => (
  <Stack bg="bg.subtle" borderColor="border.subtle" borderWidth="1px" gap="2" minW="0" p="3" rounded="md" shadow="sm">
    {children}
  </Stack>
);

/**
 * The footer for one tile in the multi-session grid.
 *
 * A tile has no board position to report and no prev/next to offer, so it
 * spends the same row on the two facts that are specific to it: which device is
 * rendering, and how far along it is. It always names its state — with several
 * sessions racing, a tile saying nothing reads as a stuck one.
 */
export const PreviewTileFooter = ({ deviceLabel, percent }: { deviceLabel: string | null; percent: number | null }) => {
  const { t } = useTranslation();
  const statusLabel = percent === null ? t('common.generating') : `${percent}%`;

  return (
    <PreviewFooterIsland>
      <HStack align="center" gap="1" minW="0">
        {deviceLabel === null ? null : (
          <>
            <Text color="fg.muted" fontSize="2xs" truncate>
              {deviceLabel}
            </Text>
            <Text color="fg.subtle" flexShrink={0} fontSize="2xs">
              ·
            </Text>
          </>
        )}
        <Text color="fg.muted" flexShrink={0} fontSize="2xs" fontVariantNumeric="tabular-nums">
          {statusLabel}
        </Text>
      </HStack>
    </PreviewFooterIsland>
  );
};
