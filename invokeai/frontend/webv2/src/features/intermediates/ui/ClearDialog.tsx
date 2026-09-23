import type { IntermediatesCleanupMode, IntermediatesPreview } from '@features/intermediates/core/types';
/* eslint-disable react-perf/jsx-no-new-function-as-prop */
import type { RefObject } from 'react';

import { Alert, Box, chakra, Checkbox, Dialog, Input, Portal, Spinner, Stack, Text } from '@chakra-ui/react';
import { Button, CloseButton } from '@platform/ui/Button';
import { useCallback, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatBytes } from './format';

const CONFIRM_WORD = 'CLEAR';

export interface ClearDialogState {
  mode: IntermediatesCleanupMode;
  /** Minted with each preview and reused for every Confirm of it, so a lost response replays the same operation. */
  idempotencyKey: string;
  /** Null until the server preview arrives; a confirmation is only ever offered for a fresh preview. */
  preview: IntermediatesPreview | null;
  previewError: string | null;
  isStarting: boolean;
  startError: string | null;
}

export interface ClearDialogProps {
  state: ClearDialogState | null;
  finalFocusRef: RefObject<HTMLElement | null>;
  /** Receives focus when the trigger can no longer take it, e.g. a Delete button disabled by the cleared selection. */
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onConfirm: () => void;
  onRetryPreview: () => void;
  /** Re-previews in the other mode; force also deletes items saved documents still reference. */
  onModeChange: (mode: IntermediatesCleanupMode) => void;
}

const Impact = ({ preview }: { preview: IntermediatesPreview }) => {
  const { t } = useTranslation();
  const { impact } = preview;
  const referenced = impact.keepReferencedImages + impact.keepReferencedVideos;
  const active = impact.keepActiveImages + impact.keepActiveVideos;
  const recent = impact.keepRecentImages + impact.keepRecentVideos;
  const kept = referenced + active + recent;
  const nothing = impact.deleteImages + impact.deleteVideos === 0;

  return (
    <Stack gap="1.5">
      <Text fontSize="sm" fontWeight="600">
        {nothing
          ? t('intermediates.dialog.nothing')
          : t('intermediates.dialog.summary', {
              images: t('intermediates.counts.images', { count: impact.deleteImages }),
              projects: t('intermediates.counts.projects', { count: preview.targetRows }),
              videos: t('intermediates.counts.videos', { count: impact.deleteVideos }),
            })}
      </Text>
      {nothing ? null : (
        <Text fontSize="xs">
          {impact.unknownSizeCount > 0 && impact.reclaimableBytes === 0
            ? t('intermediates.dialog.reclaimUnknown')
            : t('intermediates.dialog.reclaim', { size: formatBytes(impact.reclaimableBytes) })}
          {impact.unknownSizeCount > 0 && impact.reclaimableBytes > 0
            ? ` ${t('intermediates.dialog.reclaimPartial', { count: impact.unknownSizeCount })}`
            : ''}
        </Text>
      )}
      {kept > 0 ? (
        <Text color="fg.muted" fontSize="xs">
          {t('intermediates.dialog.kept', { count: kept })}{' '}
          {t('intermediates.dialog.keptReasons', {
            active: t('intermediates.counts.items', { count: active }),
            recent: t('intermediates.counts.items', { count: recent }),
            referenced: t('intermediates.counts.items', { count: referenced }),
          })}
        </Text>
      ) : null}
    </Stack>
  );
};

const AffectedDocuments = ({ preview }: { preview: IntermediatesPreview }) => {
  const { t } = useTranslation();

  if (preview.affectedDocuments.length === 0 && preview.affectedDocumentsHidden === 0) {
    return null;
  }

  return (
    <Stack gap="1">
      <Text fontSize="xs" fontWeight="600">
        {t('intermediates.dialog.affected')}
      </Text>
      <Stack as="ul" gap="0.5" maxH="32" overflowY="auto" ps="4">
        {preview.affectedDocuments.map((document) => (
          <Text as="li" fontSize="xs" key={`${document.kind}:${document.userId}:${document.ownerId}`}>
            {t(
              document.kind === 'project'
                ? 'intermediates.dialog.affectedProject'
                : 'intermediates.dialog.affectedWorkflow',
              { count: document.references, name: document.name ?? document.ownerId }
            )}
          </Text>
        ))}
        {preview.affectedDocumentsHidden > 0 ? (
          <Text as="li" color="fg.muted" fontSize="xs">
            {t('intermediates.dialog.affectedHidden', { count: preview.affectedDocumentsHidden })}
          </Text>
        ) : null}
      </Stack>
    </Stack>
  );
};

/**
 * One confirmation for both modes. The default deletes only safe items; the advanced disclosure switches to a
 * force preview, which adds the affected documents, an acknowledgement and a typed confirmation.
 */
export const ClearDialog = ({
  fallbackFocusRef,
  finalFocusRef,
  onClose,
  onConfirm,
  onModeChange,
  onRetryPreview,
  state,
}: ClearDialogProps) => {
  const { t } = useTranslation();
  // The acknowledgement and typed word belong to one preview; a re-preview (mode switch, retry) starts over.
  const [confirmation, setConfirmation] = useState<{ previewId: string; acknowledged: boolean; typed: string }>({
    acknowledged: false,
    previewId: '',
    typed: '',
  });
  const confirmInputId = useId();
  const isForce = state?.mode === 'force';
  const preview = state?.preview ?? null;
  const acknowledged = confirmation.previewId === preview?.previewId && confirmation.acknowledged;
  const typed = confirmation.previewId === preview?.previewId ? confirmation.typed : '';
  const setAcknowledged = (value: boolean) =>
    setConfirmation({ acknowledged: value, previewId: preview?.previewId ?? '', typed });
  const setTyped = (value: string) =>
    setConfirmation({ acknowledged, previewId: preview?.previewId ?? '', typed: value });
  const nothingToDelete = preview !== null && preview.impact.deleteImages + preview.impact.deleteVideos === 0;
  const forceReady = !isForce || (acknowledged && typed.trim() === CONFIRM_WORD);
  const canConfirm = preview !== null && !nothingToDelete && forceReady && !state?.isStarting;

  const handleOpenChange = useCallback(
    (event: { open: boolean }) => {
      if (!event.open && !state?.isStarting) {
        onClose();
      }
    },
    [onClose, state?.isStarting]
  );
  const handleExitComplete = useCallback(() => {
    setConfirmation({ acknowledged: false, previewId: '', typed: '' });
  }, []);

  return (
    <Dialog.Root
      closeOnEscape={!state?.isStarting}
      closeOnInteractOutside={!state?.isStarting}
      finalFocusEl={() => {
        const trigger = finalFocusRef.current;

        return trigger && !(trigger as HTMLButtonElement).disabled ? trigger : fallbackFocusRef.current;
      }}
      lazyMount
      open={state !== null}
      role="alertdialog"
      size="sm"
      unmountOnExit
      onExitComplete={handleExitComplete}
      onOpenChange={handleOpenChange}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>
                {isForce ? t('intermediates.dialog.forceTitle') : t('intermediates.dialog.title')}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap="3">
                {/* zag snapshots aria-describedby at open, so the Description must exist before the preview lands. */}
                <Dialog.Description asChild>
                  <Box>
                    {state?.previewError ? (
                      <Alert.Root size="sm" status="error" variant="surface">
                        <Alert.Indicator />
                        <Alert.Content>
                          <Alert.Description>{state.previewError}</Alert.Description>
                        </Alert.Content>
                        <Button size="2xs" variant="outline" onClick={onRetryPreview}>
                          {t('common.retry')}
                        </Button>
                      </Alert.Root>
                    ) : preview === null ? (
                      <Stack align="center" direction="row" gap="2">
                        <Spinner color="fg.muted" size="xs" />
                        <Text color="fg.muted" fontSize="xs">
                          {t('intermediates.dialog.loadingPreview')}
                        </Text>
                      </Stack>
                    ) : (
                      <Impact preview={preview} />
                    )}
                  </Box>
                </Dialog.Description>
                <Checkbox.Root
                  checked={isForce}
                  colorPalette="red"
                  disabled={state?.isStarting}
                  size="sm"
                  onCheckedChange={(event) => onModeChange(event.checked === true ? 'force' : 'safe')}
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label fontSize="xs">{t('intermediates.dialog.forceToggle')}</Checkbox.Label>
                </Checkbox.Root>
                {isForce ? (
                  <Alert.Root size="sm" status="warning" variant="surface">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Description>{t('intermediates.dialog.forceWarning')}</Alert.Description>
                    </Alert.Content>
                  </Alert.Root>
                ) : null}
                {isForce && preview ? <AffectedDocuments preview={preview} /> : null}
                {isForce && preview && !nothingToDelete ? (
                  <Stack gap="2">
                    <Checkbox.Root
                      checked={acknowledged}
                      colorPalette="red"
                      size="sm"
                      onCheckedChange={(event) => setAcknowledged(event.checked === true)}
                    >
                      <Checkbox.HiddenInput />
                      <Checkbox.Control />
                      <Checkbox.Label fontSize="xs">{t('intermediates.dialog.acknowledge')}</Checkbox.Label>
                    </Checkbox.Root>
                    <Stack gap="1">
                      <chakra.label fontSize="xs" htmlFor={confirmInputId}>
                        {t('intermediates.dialog.typeToConfirm', { word: CONFIRM_WORD })}
                      </chakra.label>
                      <Input
                        autoComplete="off"
                        id={confirmInputId}
                        size="xs"
                        spellCheck={false}
                        value={typed}
                        onChange={(event) => setTyped(event.currentTarget.value)}
                      />
                    </Stack>
                  </Stack>
                ) : null}
                {state?.startError ? (
                  <Text color="fg.error" fontSize="xs" role="alert">
                    {state.startError}
                  </Text>
                ) : null}
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Button disabled={state?.isStarting} size="xs" variant="ghost" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button
                colorPalette="red"
                disabled={!canConfirm}
                loading={state?.isStarting}
                size="xs"
                variant="solid"
                onClick={onConfirm}
              >
                {isForce ? t('intermediates.dialog.forceConfirm') : t('intermediates.dialog.confirm')}
              </Button>
            </Dialog.Footer>
            <Dialog.CloseTrigger asChild>
              <CloseButton disabled={state?.isStarting} />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
};
