import type { BuiltInLayoutPresetId } from '@workbench/layoutContracts';
import type { LucideIcon } from 'lucide-react';

import { Icon, Menu, Portal } from '@chakra-ui/react';
import { Button, IconButton } from '@platform/ui/Button';
import { Group } from '@platform/ui/Group';
import { MenuContent } from '@platform/ui/Menu';
import { Link } from '@tanstack/react-router';
import { BUILT_IN_LAYOUT_PRESET_LABELS, LAUNCHPAD_LAYOUT_IDS } from '@workbench/launchpad/intents';
import { ChevronDownIcon, ClapperboardIcon, LayersIcon, PlusIcon, TypeIcon, WorkflowIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Plain clicks use the last preset; the caret chooses a built-in arrangement. Shared labels avoid drift without
 * importing preset snapshots or the custom icon catalog.
 */

const NEW_PROJECT_SEARCH = { new: true } as const;
const MENU_POSITIONING = { placement: 'bottom-end' } as const;

const LAYOUT_ICONS: Record<BuiltInLayoutPresetId, LucideIcon> = {
  automate: WorkflowIcon,
  compose: TypeIcon,
  edit: LayersIcon,
  video: ClapperboardIcon,
};

interface NewProjectLayoutItem {
  icon: LucideIcon;
  id: BuiltInLayoutPresetId;
  label: string;
  search: { new: true; preset: BuiltInLayoutPresetId };
}

const LAYOUT_ITEMS: NewProjectLayoutItem[] = LAUNCHPAD_LAYOUT_IDS.map((id) => ({
  icon: LAYOUT_ICONS[id],
  id,
  label: BUILT_IN_LAYOUT_PRESET_LABELS[id],
  search: { new: true, preset: id },
}));

export const NewProjectButton = ({ variant = 'solid' }: { variant?: 'outline' | 'solid' }) => {
  const { t } = useTranslation();

  return (
    <Group attached>
      <Button asChild size="xs" variant={variant}>
        <Link search={NEW_PROJECT_SEARCH} to="/app">
          <Icon as={PlusIcon} boxSize="3.5" />
          {t('projects.newProject')}
        </Link>
      </Button>
      <Menu.Root positioning={MENU_POSITIONING}>
        <Menu.Trigger asChild>
          <IconButton aria-label={t('projects.newProjectWithLayout')} size="xs" variant={variant}>
            <Icon as={ChevronDownIcon} boxSize="3.5" />
          </IconButton>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <MenuContent minW="12rem">
              <Menu.ItemGroup>
                <Menu.ItemGroupLabel>{t('projects.newProjectWithLayout')}</Menu.ItemGroupLabel>
                {LAYOUT_ITEMS.map((item) => (
                  <NewProjectLayoutMenuItem key={item.id} item={item} />
                ))}
              </Menu.ItemGroup>
            </MenuContent>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    </Group>
  );
};

const NewProjectLayoutMenuItem = ({ item }: { item: NewProjectLayoutItem }) => (
  <Menu.Item asChild value={item.id}>
    <Link search={item.search} to="/app">
      <Icon as={item.icon} boxSize="3.5" color="fg.subtle" />
      <Menu.ItemText fontSize="xs">{item.label}</Menu.ItemText>
    </Link>
  </Menu.Item>
);
