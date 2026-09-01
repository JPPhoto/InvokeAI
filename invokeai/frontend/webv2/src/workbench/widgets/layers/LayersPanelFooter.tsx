import type { LucideIcon } from 'lucide-react';

import { HStack, Input, Text } from '@chakra-ui/react';
import { IconButton } from '@platform/ui/Button';
import { Tooltip } from '@platform/ui/Tooltip';
import { CopyIcon, FolderPlusIcon, Trash2Icon } from 'lucide-react';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import type { LayerSelectionCommands } from './useLayerSelectionCommands';

const ACTION_TOOLTIP_POSITIONING = { placement: 'top' } as const;

interface LayersPanelFooterProps {
  commands: LayerSelectionCommands;
  degraded: boolean;
  filter: string;
  groupCount: number;
  leafCount: number;
  selectedCount: number;
  onFilterChange: (filter: string) => void;
}

/**
 * The stable footer — the panel's one action strip: name filter, document
 * summary, and the top-frequency selection verbs (duplicate, group, delete).
 * Everything else lives in the context menu; nothing here appears or
 * disappears — controls disable instead.
 */
const LayersPanelFooterComponent = ({
  commands,
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
      <HStack gap="0.5">
        <FooterAction
          disabled={!commands.canDuplicate}
          icon={CopyIcon}
          label={t('widgets.layers.actions.duplicateSelected')}
          onRun={commands.duplicateSelected}
        />
        <FooterAction
          disabled={!commands.canGroup}
          icon={FolderPlusIcon}
          label={t('widgets.layers.actions.groupSelected')}
          onRun={commands.groupSelected}
        />
        <FooterAction
          colorPalette="red"
          disabled={!commands.canDelete}
          icon={Trash2Icon}
          label={t('widgets.layers.actions.deleteSelected')}
          onRun={commands.deleteSelected}
        />
      </HStack>
    </HStack>
  );
};

const FooterAction = ({
  colorPalette,
  disabled,
  icon: ActionIcon,
  label,
  onRun,
}: {
  colorPalette?: string;
  disabled: boolean;
  icon: LucideIcon;
  label: string;
  onRun: () => void;
}) => (
  <Tooltip content={label} positioning={ACTION_TOOLTIP_POSITIONING}>
    <IconButton
      aria-label={label}
      colorPalette={colorPalette}
      disabled={disabled}
      size="2xs"
      variant="ghost"
      onClick={onRun}
    >
      <ActionIcon />
    </IconButton>
  </Tooltip>
);

export const LayersPanelFooter = memo(LayersPanelFooterComponent);
