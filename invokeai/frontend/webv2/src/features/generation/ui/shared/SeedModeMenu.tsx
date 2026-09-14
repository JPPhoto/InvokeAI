/* oxlint-disable react-perf/jsx-no-new-function-as-prop */
import type { SeedMode } from '@features/generation/core/seed';
import type { LucideIcon } from 'lucide-react';

import { Icon, Menu, Portal, Stack, Text } from '@chakra-ui/react';
import { SEED_MODES } from '@features/generation/core/seed';
import { Button } from '@platform/ui/Button';
import { MenuContent } from '@platform/ui/Menu';
import { Tooltip } from '@platform/ui/Tooltip';
import { ChevronDownIcon, LocateFixedIcon, MinusIcon, PlusIcon, ShuffleIcon } from 'lucide-react';
import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

const SEED_MODE_MENU_POSITIONING = { placement: 'bottom-end' } as const;
const SEED_MODE_ICONS: Record<SeedMode, LucideIcon> = {
  decrement: MinusIcon,
  fixed: LocateFixedIcon,
  increment: PlusIcon,
  random: ShuffleIcon,
};

export interface SeedModeMenuProps {
  value: SeedMode;
  onChange: (mode: SeedMode) => void;
  /** Trigger tooltip; the mode label unless the host has more to say about what a step is. */
  tooltip?: string;
  /** Class for the portaled menu content, for hosts whose key handling must skip it (xyflow's `nokey`). */
  contentClassName?: string;
}

/**
 * How the seed moves from one submission to the next. A menu rather than a
 * toggle because the choice has four answers, and each needs a line of
 * explanation the first time it is read.
 */
export const SeedModeMenu = ({ contentClassName, onChange, tooltip, value }: SeedModeMenuProps) => {
  const { t } = useTranslation();
  // Shared ids let the tooltip ride the menu trigger without wrapping it
  // (wrapping `Menu.Trigger` swallows the anchor ref — see RoutingControl).
  const triggerId = useId();
  const triggerIds = useMemo(() => ({ trigger: triggerId }), [triggerId]);
  const label = t('widgets.generate.seedMode.label');
  const valueLabel = t(`widgets.generate.seedMode.${value}`);

  return (
    <Menu.Root ids={triggerIds} positioning={SEED_MODE_MENU_POSITIONING}>
      <Tooltip content={tooltip ?? label} ids={triggerIds}>
        <Menu.Trigger asChild>
          <Button aria-label={`${label}: ${valueLabel}`} flexShrink={0} gap="1" size="xs" variant="outline">
            <Icon as={SEED_MODE_ICONS[value]} boxSize="3.5" color="fg.muted" />
            {valueLabel}
            <Icon as={ChevronDownIcon} boxSize="3" color="fg.muted" />
          </Button>
        </Menu.Trigger>
      </Tooltip>
      <Portal>
        <Menu.Positioner>
          <MenuContent className={contentClassName} minW="16rem">
            <Menu.RadioItemGroup value={value} onValueChange={(event) => onChange(event.value as SeedMode)}>
              {SEED_MODES.map((mode) => (
                <Menu.RadioItem key={mode} py="1.5" value={mode}>
                  {/* The recipe centers the check on the row; on a two-line item it belongs on the label line. */}
                  <Menu.ItemIndicator top="2" transform="none" />
                  <Icon alignSelf="flex-start" as={SEED_MODE_ICONS[mode]} boxSize="3.5" color="fg.subtle" mt="0.5" />
                  <Stack gap="0" minW="0">
                    <Menu.ItemText>{t(`widgets.generate.seedMode.${mode}`)}</Menu.ItemText>
                    <Text color="fg.subtle" fontSize="2xs">
                      {t(`widgets.generate.seedMode.${mode}Description`)}
                    </Text>
                  </Stack>
                </Menu.RadioItem>
              ))}
            </Menu.RadioItemGroup>
          </MenuContent>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
};
