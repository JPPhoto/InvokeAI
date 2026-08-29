import type {
  OperationPresentationAdapter,
  ToolbarRegionProps,
  ToolbarStatusProps,
} from '@workbench/widgets/canvas/context-toolbar/toolbarContracts';
/* oxlint-disable react-perf/jsx-no-jsx-as-prop, react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop */
import type { ChangeEvent } from 'react';

import { createListCollection, HStack, Input, Stack, Switch, Text, VisuallyHidden } from '@chakra-ui/react';
import { Button, Select, Tooltip } from '@platform/ui';
import { Group } from '@platform/ui/Group';
import {
  getCanvasOperations,
  isSamDocumentInputValid,
  type CanvasOperationCapability,
  type SamSessionError,
  type SamSessionErrorCode,
  type SamSessionSnapshot,
  type SamModel,
  type SelectObjectSaveTarget,
} from '@workbench/canvas-operations/api';
import { ToolbarStatus } from '@workbench/widgets/canvas/context-toolbar/ToolbarPrimitives';
import { useSamSession } from '@workbench/widgets/canvas/engineStoreHooks';
import { SquareMinusIcon, SquarePlusIcon } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { OperationStatusChip, OperationStatusSlot } from './OperationStatusSlot';

export interface SamActionEligibility {
  canApply: boolean;
  canCancel: boolean;
  canEditInputs: boolean;
  canProcess: boolean;
  canReset: boolean;
  canSave: boolean;
}

export interface SamPanelViewModel {
  bboxActive: boolean;
  excludeCount: number;
  includeCount: number;
  sourceLabel: string;
}

const SAM_PROMPT_GUIDANCE_ID = 'sam-prompt-guidance';
const SAM_VISUAL_GUIDANCE_ID = 'sam-visual-guidance';

const SAM_STATUS_TRANSLATION_KEYS: Record<SamSessionSnapshot['status'], string> = {
  committing: 'widgets.layers.selectObject.statusCommitting',
  error: 'widgets.layers.selectObject.statusError',
  'preparing-source': 'widgets.layers.selectObject.statusPreparingSource',
  'processing-sam': 'widgets.layers.selectObject.statusProcessingSam',
  ready: 'widgets.layers.selectObject.statusReady',
  'rendering-preview': 'widgets.layers.selectObject.statusRenderingPreview',
  scheduled: 'widgets.layers.selectObject.statusScheduled',
  uploading: 'widgets.layers.selectObject.statusUploading',
};

const SAM_ERROR_TRANSLATION_KEYS: Record<SamSessionErrorCode, string> = {
  decode: 'widgets.layers.selectObject.errorDecode',
  empty: 'widgets.layers.selectObject.errorEmpty',
  invalid: 'widgets.layers.selectObject.errorInvalid',
  locked: 'widgets.layers.selectObject.errorLocked',
  'no-output': 'widgets.layers.selectObject.errorNoOutput',
  'not-ready': 'widgets.layers.selectObject.errorNotReady',
  'output-dimension': 'widgets.layers.selectObject.errorOutputDimension',
  queue: 'widgets.layers.selectObject.errorQueue',
  reconcile: 'widgets.layers.selectObject.errorReconcile',
  unknown: 'widgets.layers.selectObject.errorUnknown',
  upload: 'widgets.layers.selectObject.errorUpload',
};

const SAVE_TARGETS: readonly SelectObjectSaveTarget[] = [
  'selection',
  'raster',
  'control',
  'inpaint_mask',
  'regional_guidance',
];

const isSamProcessingStatus = (status: SamSessionSnapshot['status']): boolean =>
  status === 'preparing-source' ||
  status === 'uploading' ||
  status === 'processing-sam' ||
  status === 'rendering-preview';

export const getSamStatusTranslationKey = (status: SamSessionSnapshot['status']): string =>
  SAM_STATUS_TRANSLATION_KEYS[status];

export const getSamErrorTranslationKey = (code: SamSessionErrorCode): string => SAM_ERROR_TRANSLATION_KEYS[code];

export const getSamPanelViewModel = (
  session: SamSessionSnapshot,
  formatSourceLabel: (layerName: string, width: number, height: number) => string
): SamPanelViewModel => ({
  bboxActive: session.input.type === 'visual' && session.input.bbox !== null,
  excludeCount: session.input.type === 'visual' ? session.input.excludePoints.length : 0,
  includeCount: session.input.type === 'visual' ? session.input.includePoints.length : 0,
  sourceLabel: formatSourceLabel(session.layerName, session.sourceRect.width, session.sourceRect.height),
});

/**
 * SAM-flavored adapter over {@link OperationStatusSlot}: the always-mounted
 * status slot that reserves its width so status/error text appearing never
 * shifts the surrounding controls.
 */
export const SamStatusSlot = ({
  error,
  errorText,
  isBusy,
  statusText,
  technicalDetailsLabel,
}: {
  error: SamSessionError | null;
  errorText: string | null;
  isBusy: boolean;
  statusText: string;
  technicalDetailsLabel: string;
}) => (
  <OperationStatusSlot
    errorDetail={error?.detail ?? null}
    errorText={error && errorText ? errorText : null}
    isBusy={isBusy}
    minW="0"
    statusText={statusText}
    technicalDetailsLabel={technicalDetailsLabel}
  />
);

/** Legacy parity: canvas adoption keeps the SAM result intermediate and out of the gallery. */
export const keepSamImageIntermediate = (_imageName: string): Promise<void> => Promise.resolve();

export const getSamActionHandlers = (operations: CanvasOperationCapability) => ({
  apply: () => void operations.applySelectObjectSession(keepSamImageIntermediate),
  cancel: () => operations.cancelSelectObjectSession(),
  process: () => void operations.processSelectObjectSession(),
  reset: () => operations.resetSelectObjectSession(),
  save: (target: SelectObjectSaveTarget) => void operations.saveSelectObjectSession(target, keepSamImageIntermediate),
});

export const getSamActionEligibility = (
  session: SamSessionSnapshot,
  isExternalInteractionLocked = false
): SamActionEligibility => {
  const isProcessing = isSamProcessingStatus(session.status);
  const actionsBlocked = session.status === 'committing' || isExternalInteractionLocked;
  const hasReadyPreview = session.hasPreview && !isProcessing && !actionsBlocked;
  return {
    canApply: hasReadyPreview,
    canCancel: true,
    canEditInputs: !actionsBlocked,
    canProcess: !isProcessing && !actionsBlocked && isSamDocumentInputValid(session.input),
    canReset: !actionsBlocked,
    canSave: hasReadyPreview,
  };
};

export const SamModeToggle = ({
  disabled,
  groupLabel = 'Selection mode',
  mode,
  onPrompt,
  onVisual,
  promptLabel,
  visualLabel,
}: {
  disabled: boolean;
  groupLabel?: string;
  mode: SamSessionSnapshot['input']['type'];
  onPrompt(): void;
  onVisual(): void;
  promptLabel: string;
  visualLabel: string;
}) => (
  <Group aria-label={groupLabel} attached flexShrink="0" role="group">
    <Button
      aria-pressed={mode === 'visual'}
      disabled={disabled}
      size="xs"
      variant={mode === 'visual' ? 'solid' : 'ghost'}
      onClick={onVisual}
    >
      {visualLabel}
    </Button>
    <Button
      aria-pressed={mode === 'prompt'}
      disabled={disabled}
      size="xs"
      variant={mode === 'prompt' ? 'solid' : 'ghost'}
      onClick={onPrompt}
    >
      {promptLabel}
    </Button>
  </Group>
);

export const SamVisualInput = ({
  disabled,
  pointLabel,
  viewModel,
  onExclude,
  onInclude,
}: {
  disabled: boolean;
  pointLabel: SamSessionSnapshot['pointLabel'];
  viewModel: SamPanelViewModel;
  onExclude(): void;
  onInclude(): void;
}) => {
  const { t } = useTranslation();
  const includeLabel = t('widgets.layers.selectObject.includeCount', { count: viewModel.includeCount });
  const excludeLabel = t('widgets.layers.selectObject.excludeCount', { count: viewModel.excludeCount });
  return (
    <Group
      aria-describedby={SAM_VISUAL_GUIDANCE_ID}
      aria-label={t('widgets.layers.selectObject.pointType')}
      attached
      flexShrink="0"
      role="group"
    >
      <VisuallyHidden id={SAM_VISUAL_GUIDANCE_ID}>{t('widgets.layers.selectObject.visualGuidance')}</VisuallyHidden>
      <Tooltip content={includeLabel}>
        <Button
          aria-label={includeLabel}
          aria-pressed={pointLabel === 'include'}
          disabled={disabled}
          px="1.5"
          size="xs"
          variant={pointLabel === 'include' ? 'solid' : 'outline'}
          onClick={onInclude}
        >
          <SquarePlusIcon />
          <Text as="span" fontVariantNumeric="tabular-nums">
            {viewModel.includeCount}
          </Text>
        </Button>
      </Tooltip>
      <Tooltip content={excludeLabel}>
        <Button
          aria-label={excludeLabel}
          aria-pressed={pointLabel === 'exclude'}
          disabled={disabled}
          px="1.5"
          size="xs"
          variant={pointLabel === 'exclude' ? 'solid' : 'outline'}
          onClick={onExclude}
        >
          <SquareMinusIcon />
          <Text as="span" fontVariantNumeric="tabular-nums">
            {viewModel.excludeCount}
          </Text>
        </Button>
      </Tooltip>
    </Group>
  );
};

/** Whether a visual box is placed; lives in the More menu beside the settings. */
export const SamBboxIndicator = ({ viewModel }: { viewModel: SamPanelViewModel }) => {
  const { t } = useTranslation();
  const bboxText = viewModel.bboxActive
    ? t('widgets.layers.selectObject.bboxActive')
    : t('widgets.layers.selectObject.bboxInactive');
  return (
    <Text color={viewModel.bboxActive ? 'fg' : 'fg.subtle'} fontSize="xs" fontWeight="medium">
      {bboxText}
    </Text>
  );
};

export const SamPromptBody = ({
  disabled,
  prompt,
  onChange,
}: {
  disabled: boolean;
  prompt: string;
  onChange(event: ChangeEvent<HTMLInputElement>): void;
}) => {
  const { t } = useTranslation();
  return (
    <>
      <Input
        aria-describedby={SAM_PROMPT_GUIDANCE_ID}
        aria-label={t('widgets.layers.selectObject.prompt')}
        autoComplete="off"
        disabled={disabled}
        flexShrink={0}
        h="8"
        placeholder={t('widgets.layers.selectObject.promptGuidance')}
        size="xs"
        value={prompt}
        w="7.5rem"
        onChange={onChange}
      />
      <VisuallyHidden id={SAM_PROMPT_GUIDANCE_ID}>{t('widgets.layers.selectObject.promptGuidance')}</VisuallyHidden>
    </>
  );
};

const SamSettingsSwitch = ({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange(checked: boolean): void;
}) => (
  <Switch.Root
    checked={checked}
    disabled={disabled}
    justifyContent="space-between"
    size="sm"
    w="full"
    onCheckedChange={({ checked: next }) => onChange(next)}
  >
    <Switch.Label fontSize="xs">{label}</Switch.Label>
    <Switch.HiddenInput />
    <Switch.Control>
      <Switch.Thumb />
    </Switch.Control>
  </Switch.Root>
);

/** Set-once session settings (model, refinement, preview behavior), shown in the More menu. */
export const SamSettings = ({
  eligibility,
  isProcessing,
  session,
  onModelChange,
  onToggle,
}: {
  eligibility: SamActionEligibility;
  isProcessing: boolean;
  session: SamSessionSnapshot;
  onModelChange(model: SamModel): void;
  onToggle(key: 'applyPolygonRefinement' | 'autoProcess' | 'isolatedPreview', value: boolean): void;
}) => {
  const { t } = useTranslation();
  const modelValue = useMemo(() => [session.model], [session.model]);
  const modelCollection = useMemo(
    () =>
      createListCollection({
        items: [
          { label: t('widgets.layers.selectObject.modelSam2Large'), value: 'segment-anything-2-large' },
          { label: t('widgets.layers.selectObject.modelHuge'), value: 'segment-anything-huge' },
        ] as const,
      }),
    [t]
  );
  return (
    <Stack aria-label={t('widgets.layers.selectObject.settings')} gap="2" role="group" w="full">
      <Stack gap="1">
        <Text asChild fontSize="xs" fontWeight="semibold">
          <label htmlFor="sam-model">{t('widgets.layers.selectObject.model')}</label>
        </Text>
        <Select
          collection={modelCollection}
          disabled={isProcessing || !eligibility.canEditInputs}
          ids={{ trigger: 'sam-model' }}
          size="xs"
          value={modelValue}
          onValueChange={({ value }) => {
            const model = value[0];
            if (model === 'segment-anything-2-large' || model === 'segment-anything-huge') {
              onModelChange(model);
            }
          }}
        />
      </Stack>
      <SamSettingsSwitch
        checked={session.applyPolygonRefinement}
        disabled={isProcessing || !eligibility.canEditInputs}
        label={t('widgets.layers.selectObject.refine')}
        onChange={(value) => onToggle('applyPolygonRefinement', value)}
      />
      <SamSettingsSwitch
        checked={session.autoProcess}
        disabled={!eligibility.canEditInputs}
        label={t('widgets.layers.selectObject.autoProcess')}
        onChange={(value) => onToggle('autoProcess', value)}
      />
      <SamSettingsSwitch
        checked={session.isolatedPreview}
        disabled={!eligibility.canEditInputs}
        label={t('widgets.layers.selectObject.isolatedPreview')}
        onChange={(value) => onToggle('isolatedPreview', value)}
      />
    </Stack>
  );
};

/** Bar width of the mode toggle plus the point buttons or the prompt input; invert lives in More. */
export const SAM_MODES_WIDTH_PX = 244;

/** Input mode, the visual point labels or the prompt, and invert: what changes between previews. */
export const SamModes = ({ engine, isSurfaceInteractionLocked }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const session = useSamSession(engine);
  const operations = getCanvasOperations(engine);
  if (!session) {
    return null;
  }
  const eligibility = getSamActionEligibility(session, isSurfaceInteractionLocked);
  const viewModel = getSamPanelViewModel(session, (layerName, width, height) =>
    t('widgets.layers.selectObject.sourceLayerLabel', {
      height,
      name: layerName,
      type: t(`widgets.layers.selectObject.saveAs_${session.layerType}`),
      width,
    })
  );
  return (
    <>
      <SamModeToggle
        disabled={!eligibility.canEditInputs}
        groupLabel={t('widgets.layers.selectObject.mode')}
        mode={session.input.type}
        promptLabel={t('widgets.layers.selectObject.promptMode')}
        visualLabel={t('widgets.layers.selectObject.visual')}
        onPrompt={() => operations.updateSelectObjectSession({ input: { prompt: '', type: 'prompt' } })}
        onVisual={() =>
          operations.updateSelectObjectSession({
            input: { bbox: null, excludePoints: [], includePoints: [], type: 'visual' },
          })
        }
      />
      {session.input.type === 'visual' ? (
        <SamVisualInput
          disabled={!eligibility.canEditInputs}
          pointLabel={session.pointLabel}
          viewModel={viewModel}
          onExclude={() => operations.updateSelectObjectSession({ pointLabel: 'exclude' })}
          onInclude={() => operations.updateSelectObjectSession({ pointLabel: 'include' })}
        />
      ) : (
        <SamPromptBody
          disabled={!eligibility.canEditInputs}
          prompt={session.input.prompt}
          onChange={(event) =>
            operations.updateSelectObjectSession({ input: { prompt: event.currentTarget.value, type: 'prompt' } })
          }
        />
      )}
    </>
  );
};

/** Session settings plus the secondary commands; C2 moves these into Properties → Operation. */
export const SamMore = ({ engine, isSurfaceInteractionLocked }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const session = useSamSession(engine);
  const operations = getCanvasOperations(engine);
  if (!session) {
    return null;
  }
  const eligibility = getSamActionEligibility(session, isSurfaceInteractionLocked);
  const actions = getSamActionHandlers(operations);
  const isProcessing = isSamProcessingStatus(session.status);
  const viewModel = getSamPanelViewModel(session, (layerName, width, height) =>
    t('widgets.layers.selectObject.sourceLayerLabel', {
      height,
      name: layerName,
      type: t(`widgets.layers.selectObject.saveAs_${session.layerType}`),
      width,
    })
  );
  return (
    <Stack gap="2" w="full">
      <HStack gap="2">
        <Button
          aria-pressed={session.invert}
          disabled={!eligibility.canEditInputs}
          size="xs"
          variant={session.invert ? 'solid' : 'ghost'}
          onClick={() => operations.updateSelectObjectSession({ invert: !session.invert })}
        >
          {t('widgets.layers.selectObject.invert')}
        </Button>
        {session.input.type === 'visual' ? <SamBboxIndicator viewModel={viewModel} /> : null}
      </HStack>
      <SamSettings
        eligibility={eligibility}
        isProcessing={isProcessing}
        session={session}
        onModelChange={(model) => operations.updateSelectObjectSession({ model })}
        onToggle={(key, value) => operations.updateSelectObjectSession({ [key]: value })}
      />
      <HStack flexWrap="wrap" gap="1">
        <Button disabled={!eligibility.canProcess} loading={isProcessing} size="xs" onClick={actions.process}>
          {t('widgets.layers.selectObject.process')}
        </Button>
        <Button disabled={!eligibility.canReset} size="xs" variant="ghost" onClick={actions.reset}>
          {t('widgets.layers.selectObject.reset')}
        </Button>
      </HStack>
      <HStack aria-label={t('widgets.layers.selectObject.saveAs')} flexWrap="wrap" gap="1" role="group">
        {SAVE_TARGETS.map((target) => (
          <Button
            key={target}
            disabled={!eligibility.canSave}
            size="xs"
            variant="ghost"
            onClick={() => actions.save(target)}
          >
            {t(`widgets.layers.selectObject.saveAs_${target}`)}
          </Button>
        ))}
      </HStack>
    </Stack>
  );
};

export const SamStatus = ({ compact, engine, isExternalInteractionLocked }: ToolbarStatusProps) => {
  const { t } = useTranslation();
  const session = useSamSession(engine);
  const actions = useMemo(() => getSamActionHandlers(getCanvasOperations(engine)), [engine]);
  const onApply = useCallback(() => actions.apply(), [actions]);
  const onCancel = useCallback(() => actions.cancel(), [actions]);
  if (!session) {
    return <ToolbarStatus compact={compact} />;
  }
  const eligibility = getSamActionEligibility(session, isExternalInteractionLocked);
  const isProcessing = isSamProcessingStatus(session.status);
  const isBusy = !session.error && (isProcessing || session.status === 'scheduled' || session.status === 'committing');
  const sourceLabel = t('widgets.layers.selectObject.sourceLayerLabel', {
    height: session.sourceRect.height,
    name: session.layerName,
    type: t(`widgets.layers.selectObject.saveAs_${session.layerType}`),
    width: session.sourceRect.width,
  });
  return (
    <ToolbarStatus
      applyDisabled={!eligibility.canApply}
      applyLoading={session.status === 'committing'}
      cancelDisabled={!eligibility.canCancel}
      compact={compact}
      onApply={onApply}
      onCancel={onCancel}
    >
      <OperationStatusChip
        compact={compact}
        errorDetail={session.error?.detail ?? null}
        errorText={session.error ? t(getSamErrorTranslationKey(session.error.code)) : null}
        isBusy={isBusy}
        sourceLabel={sourceLabel}
        statusText={t(getSamStatusTranslationKey(session.status))}
        technicalDetailsLabel={t('widgets.layers.selectObject.technicalDetails')}
        title={t('widgets.layers.selectObject.title')}
      />
    </ToolbarStatus>
  );
};

export const selectObjectOperationAdapter: OperationPresentationAdapter = {
  kind: 'select-object',
  modes: { component: SamModes, width: SAM_MODES_WIDTH_PX },
  more: SamMore,
  status: SamStatus,
};
