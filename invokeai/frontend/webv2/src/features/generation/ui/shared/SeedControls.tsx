/* oxlint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-jsx-as-prop */
import type { SeedMode, SeedSubmissionPlan } from '@features/generation/core/seed';
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
export const TABULAR_NUMS = { fontVariantNumeric: 'tabular-nums' } as const;
const SEED_MODE_ICONS: Record<SeedMode, LucideIcon> = {
  decrement: MinusIcon,
  fixed: LocateFixedIcon,
  increment: PlusIcon,
  random: ShuffleIcon,
};

export interface SeedModeMenuProps {
  value: SeedMode;
  onChange: (mode: SeedMode) => void;
  /** A second tooltip line for hosts that need to say what one step means (a queued run, not a loop pass). */
  description?: string;
  /** Class for the portaled menu content, for hosts whose key handling must skip it (xyflow's `nokey`). */
  contentClassName?: string;
}

/**
 * How the seed moves from one submission to the next. A menu rather than a
 * toggle because the choice has four answers, and each needs a line of
 * explanation the first time it is read.
 */
export const SeedModeMenu = ({ contentClassName, description, onChange, value }: SeedModeMenuProps) => {
  const { t } = useTranslation();
  // Shared ids let the tooltip ride the menu trigger without wrapping it
  // (wrapping `Menu.Trigger` swallows the anchor ref — see RoutingControl).
  const triggerId = useId();
  const triggerIds = useMemo(() => ({ trigger: triggerId }), [triggerId]);
  const label = t('widgets.generate.seedMode.label');
  const valueLabel = t(`widgets.generate.seedMode.${value}`);
  const accessibleName = `${label}: ${valueLabel}`;

  return (
    <Menu.Root ids={triggerIds} positioning={SEED_MODE_MENU_POSITIONING}>
      {/* The visible label may truncate in a dense row; the full name always reads here and in the tooltip. */}
      <Tooltip
        content={
          description ? (
            <Stack gap="0.5">
              <Text>{accessibleName}</Text>
              <Text color="fg.subtle">{description}</Text>
            </Stack>
          ) : (
            accessibleName
          )
        }
        ids={triggerIds}
      >
        <Menu.Trigger asChild>
          <Button aria-label={accessibleName} flexShrink={0} gap="1" maxW="9rem" minW="0" size="xs" variant="outline">
            <Icon as={SEED_MODE_ICONS[value]} boxSize="3.5" color="fg.muted" flexShrink={0} />
            <Text as="span" minW="0" truncate>
              {valueLabel}
            </Text>
            <Icon as={ChevronDownIcon} boxSize="3" color="fg.muted" flexShrink={0} />
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

export interface SeedSequencePreviewProps {
  /** Id the seed input names in `aria-describedby`. */
  id?: string;
  plan: Pick<SeedSubmissionPlan, 'lastSeed' | 'sequenceLength' | 'startSeed'>;
}

/** Where the next submission's seeds start and end; the host resolves the run count it plans with. */
export const SeedSequencePreview = ({ id, plan }: SeedSequencePreviewProps) => {
  const { t } = useTranslation();

  return (
    <Text color="fg.subtle" css={TABULAR_NUMS} data-testid="seed-sequence-preview" fontSize="2xs" id={id}>
      {plan.sequenceLength > 1
        ? t('widgets.generate.seedNextBatchRange', { first: plan.startSeed, last: plan.lastSeed })
        : t('widgets.generate.seedNextBatch', { seed: plan.startSeed })}
    </Text>
  );
};
