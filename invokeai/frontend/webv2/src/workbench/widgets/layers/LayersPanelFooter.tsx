import { HStack, Input, Text } from '@chakra-ui/react';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

interface LayersPanelFooterProps {
  degraded: boolean;
  filter: string;
  groupCount: number;
  leafCount: number;
  selectedCount: number;
  onFilterChange: (filter: string) => void;
}

/** The stable footer: document summary and name filter; nothing here appears or disappears. */
const LayersPanelFooterComponent = ({
  degraded,
  filter,
  groupCount,
  leafCount,
  selectedCount,
  onFilterChange,
}: LayersPanelFooterProps) => {
  const { t } = useTranslation();
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
    </HStack>
  );
};

export const LayersPanelFooter = memo(LayersPanelFooterComponent);
