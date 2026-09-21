import type { SettingFieldProps } from '@platform/ui/settings/contracts';

import { Badge, Field, HStack, Input, Stack } from '@chakra-ui/react';
import { resolveSettingsText } from '@platform/ui/settings/contracts';
import { ModifiedSettingIndicator } from '@platform/ui/settings/ModifiedSettingIndicator';
import { getImageMapClusterEps, MAX_CLUSTER_EPS, MIN_CLUSTER_EPS } from '@workbench/image-map/imageMapSettings';
import { imageMapStore } from '@workbench/image-map/imageMapStore';
import { useWidgetSettingsTarget } from '@workbench/settings/useWidgetSettingsTarget';
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Long enough that a spinner held down, or a three-digit number typed in
 * full, costs one recluster rather than one per keystroke — reclustering a
 * six-figure gallery is seconds of server CPU. Short enough that a deliberate
 * edit feels answered.
 */
const COMMIT_DEBOUNCE_MS = 500;

const DIALOG_DIRECTION = { base: 'column', md: 'row' } as const;
const DIALOG_ALIGNMENT = { base: 'stretch', md: 'center' } as const;

/** Trims the heuristic's float to something a 0.01 spinner can step from. */
const forDisplay = (eps: number): string => String(Number(eps.toFixed(3)));

/**
 * "Clustering strength" — the DBSCAN eps, as a number the user can nudge.
 *
 * Not a shared `number` setting because of the empty state: blank means "go
 * back to deriving it", which is the only way out of a value once chosen, and
 * the shared control cannot express it (it is fully controlled and drops
 * anything unparseable). The derived value is shown in the box rather than as
 * a placeholder, so the number on screen is always the one the map used.
 */
export const ClusterStrengthField = ({ field, surface, target }: SettingFieldProps) => {
  const { t } = useTranslation();
  const { disabled, patch, value: chosen } = useWidgetSettingsTarget('image-map', target, getImageMapClusterEps);
  // What the server actually clustered with, which is the heuristic's answer
  // whenever nothing has been chosen.
  const resolved = imageMapStore.useSnapshot().data?.clusterEps ?? null;
  const shown = chosen ?? resolved;
  const [invalid, setInvalid] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false);
  // Uncontrolled on purpose. A controlled `value` driven from the element
  // would erase exactly the input this field has to tolerate: `type="number"`
  // reports "" for a half-typed "0.", so React would write that "" straight
  // back and wipe the keystrokes out from under the cursor — taking
  // `badInput` with them, which is the only signal distinguishing a partial
  // number from a deliberately cleared box.
  const input = useRef<HTMLInputElement | null>(null);

  const commit = useCallback(
    (eps: number | null) => {
      pending.current = false;
      patch({ clusterEps: eps });
    },
    [patch]
  );

  // Anything arriving from outside — a recluster's resolved value, another
  // surface changing the setting — must not move the number under the
  // cursor, so it waits until the edit has settled.
  useEffect(() => {
    if (pending.current || !input.current) {
      return;
    }

    setInvalid(null);
    input.current.value = shown === null ? '' : forDisplay(shown);
  }, [shown]);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    []
  );

  /**
   * Decide what the field now holds. Deferred behind the debounce rather than
   * run per keystroke, so the complaints only appear once the user has
   * stopped: validating eagerly makes "0.15" flash "must be at least 0.01"
   * on its way past "0".
   */
  const resolve = useCallback(
    (text: string, badInput: boolean) => {
      timer.current = null;

      // `type="number"` reports an empty value for anything it cannot parse
      // yet — ".", "-", "1e" — so an empty box alone cannot be read as "use
      // the heuristic". `badInput` is what separates a half-typed number from
      // a deliberately cleared one; without it, a pause mid-keystroke throws
      // away the strength the map was tuned to.
      if (badInput) {
        setInvalid(t('settingsDialog.fields.clusterStrengthIncomplete'));

        return;
      }

      if (text.trim() === '') {
        commit(null);

        return;
      }

      const eps = Number(text);

      if (!Number.isFinite(eps) || eps < MIN_CLUSTER_EPS || eps > MAX_CLUSTER_EPS) {
        // Refused rather than clamped: the endpoint rejects anything outside
        // this range, and quietly substituting a different number would make
        // the control disagree with the map.
        setInvalid(t('settingsDialog.fields.clusterStrengthRange', { max: MAX_CLUSTER_EPS, min: MIN_CLUSTER_EPS }));

        return;
      }

      commit(eps);
    },
    [commit, t]
  );

  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const { validity, value } = event.currentTarget;

      pending.current = true;
      setInvalid(null);

      if (timer.current !== null) {
        clearTimeout(timer.current);
      }

      timer.current = setTimeout(() => resolve(value, validity.badInput), COMMIT_DEBOUNCE_MS);
    },
    [resolve]
  );

  // Leaving the field ends the edit: flush a pending commit so a value typed
  // and then dismissed still takes effect, and otherwise release the guard so
  // a refused edit does not read as mid-edit forever.
  const onBlur = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      const field = input.current;
      resolve(field?.value ?? '', field?.validity.badInput === true);

      return;
    }

    pending.current = false;
    setInvalid(null);

    if (input.current) {
      input.current.value = shown === null ? '' : forDisplay(shown);
    }
  }, [resolve, shown]);

  const label = resolveSettingsText(field.label, t);
  const description = field.description ? resolveSettingsText(field.description, t) : undefined;

  return (
    <Field.Root
      alignItems={surface === 'quick' ? 'stretch' : DIALOG_ALIGNMENT}
      disabled={disabled}
      display="flex"
      flexDirection={surface === 'quick' ? 'column' : DIALOG_DIRECTION}
      gap="3"
      invalid={invalid !== null}
      justifyContent="space-between"
    >
      <Stack flex="1" gap="1">
        <HStack gap="2">
          <Field.Label fontSize={surface === 'quick' ? 'xs' : 'sm'} fontWeight="500">
            {label}
          </Field.Label>
          {chosen !== null ? <ModifiedSettingIndicator label={label} /> : null}
        </HStack>
        {description ? (
          <Field.HelperText color="fg.muted" fontSize="xs">
            {description}
          </Field.HelperText>
        ) : null}
        {invalid ? <Field.ErrorText fontSize="xs">{invalid}</Field.ErrorText> : null}
      </Stack>
      <HStack flexShrink={0} gap="2">
        <Input
          aria-label={label}
          defaultValue={shown === null ? '' : forDisplay(shown)}
          disabled={disabled}
          max={MAX_CLUSTER_EPS}
          min={MIN_CLUSTER_EPS}
          ref={input}
          size="sm"
          step="0.01"
          type="number"
          w="24"
          onBlur={onBlur}
          onChange={onChange}
        />
        {/* Says whose number this is: without it a derived value and a chosen
            one are the same digits in the same box. */}
        <Badge
          data-testid="cluster-strength-auto"
          size="sm"
          variant="subtle"
          visibility={chosen === null ? 'visible' : 'hidden'}
        >
          {t('settingsDialog.fields.clusterStrengthAuto')}
        </Badge>
      </HStack>
    </Field.Root>
  );
};
