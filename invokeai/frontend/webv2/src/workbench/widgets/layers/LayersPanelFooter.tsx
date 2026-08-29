import type { LayerPanelDensity } from '@workbench/layerPanelState';

import { HStack, Input, SegmentGroup, Text } from '@chakra-ui/react';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

const DENSITIES: readonly LayerPanelDensity[] = ['compact', 'comfortable', 'large'];

interface LayersPanelFooterProps {
  degraded: boolean;
  density: LayerPanelDensity;
  filter: string;
  groupCount: number;
  leafCount: number;
  selectedCount: number;
  onDensityChange: (density: LayerPanelDensity) => void;
  onFilterChange: (filter: string) => void;
}

/** The stable footer: document summary, name filter, and density; nothing here appears or disappears. */
const LayersPanelFooterComponent = ({
  degraded,
  density,
  filter,
  groupCount,
  leafCount,
  selectedCount,
  onDensityChange,
  onFilterChange,
}: LayersPanelFooterProps) => {
  const { t } = useTranslation();
  const handleDensity = useCallback(
    (details: { value: string | null }) => {
      if (details.value && (DENSITIES as readonly string[]).includes(details.value)) {
        onDensityChange(details.value as LayerPanelDensity);
      }
    },
    [onDensityChange]
  );
  const handleFilter = useCallback(
    (event: { target: { value: string } }) => onFilterChange(event.target.value),
    [onFilterChange]
  );
  return (
    <HStack borderColor="border.subtle" borderTopWidth="1px" gap="2" minH="10" px="2" py="1">
      <Input
        aria-label={t('widgets.layers.footer.filter')}
        flex="1"
        minW="0"
        placeholder={t('widgets.layers.footer.filter')}
        size="2xs"
        value={filter}
        onChange={handleFilter}
      />
      <Text color="fg.muted" flexShrink={0} fontSize="2xs" whiteSpace="nowrap">
        {degraded
          ? t('widgets.layers.footer.degraded')
          : `${t('widgets.layers.footer.layers', { count: leafCount })} · ${t('widgets.layers.footer.groups', { count: groupCount })} · ${t('widgets.layers.footer.selected', { count: selectedCount })}`}
      </Text>
      <SegmentGroup.Root
        aria-label={t('widgets.layers.footer.density.label')}
        size="xs"
        value={density}
        onValueChange={handleDensity}
      >
        <SegmentGroup.Indicator />
        {DENSITIES.map((value) => (
          <SegmentGroup.Item key={value} value={value}>
            <SegmentGroup.ItemText fontSize="2xs">{t(`widgets.layers.footer.density.${value}`)}</SegmentGroup.ItemText>
            <SegmentGroup.ItemHiddenInput />
          </SegmentGroup.Item>
        ))}
      </SegmentGroup.Root>
    </HStack>
  );
};

export const LayersPanelFooter = memo(LayersPanelFooterComponent);
