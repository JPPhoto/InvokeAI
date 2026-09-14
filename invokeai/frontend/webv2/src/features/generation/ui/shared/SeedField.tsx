/* oxlint-disable react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-jsx-as-prop */
import type { DynamicPromptsSeedBehaviour } from '@features/generation/core/dynamicPrompts';
import type { SeedMode } from '@features/generation/core/seed';
import type { ReactNode } from 'react';

import { HStack, InputGroup, NumberInput, Stack } from '@chakra-ui/react';
import { planSeedSubmission, SEED_MAX } from '@features/generation/core/seed';
import { IconButton } from '@platform/ui/Button';
import { Field } from '@platform/ui/Field';
import { DicesIcon } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { SeedModeMenu, SeedSequencePreview, TABULAR_NUMS } from './SeedControls';

const SEED_END_ELEMENT_PROPS = { pointerEvents: 'auto', pr: '0.5' } as const;

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
        {plan ? <SeedSequencePreview id={previewId} plan={plan} /> : null}
        {children}
      </Stack>
    </Field>
  );
};
