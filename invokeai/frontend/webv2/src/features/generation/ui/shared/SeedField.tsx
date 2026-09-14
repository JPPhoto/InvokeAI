/* oxlint-disable react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-jsx-as-prop */
import type { DynamicPromptsSeedBehaviour } from '@features/generation/core/dynamicPrompts';
import type { SeedMode } from '@features/generation/core/settings';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { HStack, Icon, InputGroup, Menu, NumberInput, Portal, Stack, Text } from '@chakra-ui/react';
import { planSeedSubmission, SEED_MAX, SEED_MODES } from '@features/generation/core/settings';
import { Button, IconButton } from '@platform/ui/Button';
import { Field } from '@platform/ui/Field';
import { MenuContent } from '@platform/ui/Menu';
import { Tooltip } from '@platform/ui/Tooltip';
import { ChevronDownIcon, DicesIcon, LocateFixedIcon, MinusIcon, PlusIcon, ShuffleIcon } from 'lucide-react';
import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

const SEED_END_ELEMENT_PROPS = { pointerEvents: 'auto', pr: '0.5' } as const;
const SEED_MODE_MENU_POSITIONING = { placement: 'bottom-end' } as const;
const TABULAR_NUMS = { fontVariantNumeric: 'tabular-nums' } as const;
const SEED_MODE_ICONS: Record<SeedMode, LucideIcon> = {
  decrement: MinusIcon,
  fixed: LocateFixedIcon,
  increment: PlusIcon,
  random: ShuffleIcon,
};

/**
 * How the seed moves from one submission to the next. A menu rather than a
 * toggle because the choice has four answers, and each needs a line of
 * explanation the first time it is read.
 */
const SeedModeMenu = ({ onChange, value }: { value: SeedMode; onChange: (mode: SeedMode) => void }) => {
  const { t } = useTranslation();
  // Shared ids let the tooltip ride the menu trigger without wrapping it
  // (wrapping `Menu.Trigger` swallows the anchor ref — see RoutingControl).
  const triggerId = useId();
  const triggerIds = useMemo(() => ({ trigger: triggerId }), [triggerId]);
  const label = t('widgets.generate.seedMode.label');
  const valueLabel = t(`widgets.generate.seedMode.${value}`);

  return (
    <Menu.Root ids={triggerIds} positioning={SEED_MODE_MENU_POSITIONING}>
      <Tooltip content={label} ids={triggerIds}>
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
          <MenuContent minW="16rem">
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

export interface SeedFieldPatch {
  seed?: number;
  seedMode?: SeedMode;
}

export interface SeedFieldProps {
  label: string;
  /** Validation error for the entered seed; shown only while the seed is in use. */
  error?: string | null;
  seed: number;
  seedMode: SeedMode;
  /** Iterations the next submission runs, which sizes the stepping-mode preview. */
  batchCount: number;
  /** Concrete prompts the next submission carries; one unless dynamic prompts expand it. */
  promptCount?: number;
  seedBehaviour?: DynamicPromptsSeedBehaviour;
  onCommit: (patch: SeedFieldPatch) => void;
  /** Rows under the input, such as recent seeds. */
  children?: ReactNode;
}

/**
 * The seed row every seeded widget shares: the input with the one-shot
 * new-seed action inside it and the mode menu beside it. Random quiets the
 * input but keeps its value; the stepping modes show the seed the next
 * submission starts from and preview where it will end.
 */
export const SeedField = ({
  batchCount,
  children,
  error,
  label,
  onCommit,
  promptCount = 1,
  seed,
  seedBehaviour = 'per-iteration',
  seedMode,
}: SeedFieldProps) => {
  const { t } = useTranslation();
  const previewId = useId();
  const isRandom = seedMode === 'random';
  const plan =
    seedMode === 'increment' || seedMode === 'decrement'
      ? planSeedSubmission({ batchCount, promptCount, seedBehaviour, seedMode, startSeed: seed })
      : null;

  return (
    <Field error={isRandom ? undefined : error} hint="seed" label={label}>
      <Stack gap="1" w="full">
        <HStack gap="1">
          <NumberInput.Root
            disabled={isRandom}
            max={SEED_MAX}
            min={0}
            size="xs"
            value={String(seed)}
            w="full"
            onValueChange={({ valueAsNumber }) => {
              if (Number.isFinite(valueAsNumber)) {
                onCommit({ seed: valueAsNumber });
              }
            }}
          >
            <InputGroup
              endElement={
                <IconButton
                  aria-label={t('widgets.generate.newSeed')}
                  color="fg.muted"
                  disabled={isRandom}
                  size="2xs"
                  title={t('widgets.generate.newSeed')}
                  variant="ghost"
                  onClick={() => onCommit({ seed: Math.floor(Math.random() * SEED_MAX) })}
                >
                  <DicesIcon />
                </IconButton>
              }
              endElementProps={SEED_END_ELEMENT_PROPS}
            >
              <NumberInput.Input
                aria-describedby={plan ? previewId : undefined}
                aria-label={label}
                css={TABULAR_NUMS}
              />
            </InputGroup>
          </NumberInput.Root>
          <SeedModeMenu value={seedMode} onChange={(nextMode) => onCommit({ seedMode: nextMode })} />
        </HStack>
        {plan ? (
          <Text color="fg.subtle" css={TABULAR_NUMS} data-testid="seed-sequence-preview" fontSize="2xs" id={previewId}>
            {plan.sequenceLength > 1
              ? t('widgets.generate.seedNextBatchRange', { first: plan.startSeed, last: plan.lastSeed })
              : t('widgets.generate.seedNextBatch', { seed: plan.startSeed })}
          </Text>
        ) : null}
        {children}
      </Stack>
    </Field>
  );
};
