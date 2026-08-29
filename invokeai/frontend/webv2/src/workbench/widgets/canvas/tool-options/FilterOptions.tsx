import type {
  OperationPresentationAdapter,
  ToolbarRegionProps,
  ToolbarStatusProps,
} from '@workbench/widgets/canvas/context-toolbar/toolbarContracts';

/* oxlint-disable react-perf/jsx-no-new-function-as-prop */
import { HStack, Stack } from '@chakra-ui/react';
import { galleryDurability } from '@features/gallery';
import { Button, Tooltip } from '@platform/ui';
import {
  buildFilterDefaults,
  getCanvasOperations,
  getFilterDefinition,
  isFilterConfigValid,
  type FilterOperationSessionState,
} from '@workbench/canvas-operations/api';
import { ToolbarStatus } from '@workbench/widgets/canvas/context-toolbar/ToolbarPrimitives';
import { useFilterSession } from '@workbench/widgets/canvas/engineStoreHooks';
import { LayerFilterControls } from '@workbench/widgets/layers/LayerFilterControls';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { OperationStatusChip } from './OperationStatusSlot';

export interface FilterActionEligibility {
  canApply: boolean;
  canCancel: boolean;
  canEdit: boolean;
  canProcess: boolean;
  canReset: boolean;
  canSave: boolean;
}

export const getFilterSaveTargetEligibility = (
  eligibility: Pick<FilterActionEligibility, 'canSave'>
): Record<'raster' | 'control', boolean> => ({
  control: eligibility.canSave,
  raster: eligibility.canSave,
});

export const getFilterActionEligibility = (
  session: FilterOperationSessionState,
  isExternalInteractionLocked = false
): FilterActionEligibility => {
  const busy = session.status === 'processing' || session.status === 'committing';
  const actionsBlocked = busy || isExternalInteractionLocked;
  const hasPreview = session.preview !== null && !actionsBlocked;
  const isValid = isFilterConfigValid(session.draft.type, session.draft.settings);
  return {
    canApply: hasPreview,
    canCancel: true,
    canEdit: !actionsBlocked,
    canProcess: !actionsBlocked && isValid,
    canReset: !actionsBlocked,
    canSave: hasPreview,
  };
};

export const getFilterStatusTranslationKey = (status: FilterOperationSessionState['status']): string =>
  status === 'processing'
    ? 'widgets.layers.rasterFilter.running'
    : status === 'committing'
      ? 'widgets.layers.rasterFilter.statusCommitting'
      : status === 'error'
        ? 'widgets.layers.rasterFilter.statusError'
        : 'widgets.layers.selectObject.statusReady';

const useFilterDraft = (engine: ToolbarRegionProps['engine']) => {
  const operations = getCanvasOperations(engine);
  const setType = useCallback(
    (type: string) => {
      const definition = getFilterDefinition(type);
      operations.updateFilterOperation({ settings: definition ? buildFilterDefaults(definition) : {}, type });
    },
    [operations]
  );
  const setSettings = useCallback(
    (settings: Record<string, unknown>) => {
      const current = operations.getFilterSessionState();
      if (current) {
        operations.updateFilterOperation({ settings, type: current.draft.type });
      }
    },
    [operations]
  );
  const reset = useCallback(() => {
    const current = operations.getFilterSessionState();
    if (current) {
      const definition = getFilterDefinition(current.draft.type);
      operations.resetFilterOperation(definition ? buildFilterDefaults(definition) : {});
    }
  }, [operations]);
  return { operations, reset, setSettings, setType };
};

/** Filter type and auto-process: the choices made while iterating on a preview. */
export const FilterModes = ({ engine, isSurfaceInteractionLocked }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const session = useFilterSession(engine);
  const { operations, setSettings, setType } = useFilterDraft(engine);
  if (!session) {
    return null;
  }
  const eligibility = getFilterActionEligibility(session, isSurfaceInteractionLocked);
  return (
    <>
      <LayerFilterControls
        disabled={!eligibility.canEdit}
        filterType={session.draft.type}
        focusFilter={false}
        parts="type"
        settings={session.draft.settings}
        variant="operation"
        onFilterTypeChange={setType}
        onSettingsChange={setSettings}
      />
      <Tooltip content={t('widgets.layers.rasterFilter.autoProcessDescription')}>
        <Button
          aria-pressed={session.autoProcess}
          disabled={!eligibility.canEdit}
          flexShrink={0}
          size="xs"
          variant={session.autoProcess ? 'solid' : 'ghost'}
          onClick={() => operations.setFilterOperationAutoProcess(!session.autoProcess)}
        >
          {t('widgets.layers.rasterFilter.autoProcess')}
        </Button>
      </Tooltip>
    </>
  );
};

/** The filter's parameters and its secondary commands; C2 moves these into Properties → Operation. */
export const FilterMore = ({ engine, isSurfaceInteractionLocked }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const session = useFilterSession(engine);
  const { operations, reset, setSettings, setType } = useFilterDraft(engine);
  if (!session) {
    return null;
  }
  const eligibility = getFilterActionEligibility(session, isSurfaceInteractionLocked);
  const saveTargets = getFilterSaveTargetEligibility(eligibility);
  return (
    <Stack gap="2" w="full">
      <LayerFilterControls
        disabled={!eligibility.canEdit}
        filterType={session.draft.type}
        focusFilter={false}
        parts="params"
        settings={session.draft.settings}
        onFilterTypeChange={setType}
        onSettingsChange={setSettings}
      />
      <HStack flexWrap="wrap" gap="1">
        <Button
          disabled={!eligibility.canProcess}
          loading={session.status === 'processing'}
          size="xs"
          onClick={() => void operations.processFilterOperation()}
        >
          {t('widgets.layers.selectObject.process')}
        </Button>
        <Button disabled={!eligibility.canReset} size="xs" variant="ghost" onClick={reset}>
          {t('widgets.layers.selectObject.reset')}
        </Button>
        <Button
          disabled={!saveTargets.raster}
          size="xs"
          variant="ghost"
          onClick={() => void operations.commitFilterOperation('raster', galleryDurability.makeCanvasAsset)}
        >
          {t('widgets.layers.selectObject.saveAs_raster')}
        </Button>
        <Button
          disabled={!saveTargets.control}
          size="xs"
          variant="ghost"
          onClick={() => void operations.commitFilterOperation('control', galleryDurability.makeCanvasAsset)}
        >
          {t('widgets.layers.selectObject.saveAs_control')}
        </Button>
      </HStack>
    </Stack>
  );
};

export const FilterStatus = ({ compact, engine, isExternalInteractionLocked }: ToolbarStatusProps) => {
  const { t } = useTranslation();
  const session = useFilterSession(engine);
  const operations = getCanvasOperations(engine);
  const onApply = useCallback(
    () => void operations.commitFilterOperation('apply', galleryDurability.makeCanvasAsset),
    [operations]
  );
  const onCancel = useCallback(() => operations.cancelFilterOperation(), [operations]);
  if (!session) {
    return <ToolbarStatus compact={compact} />;
  }
  const eligibility = getFilterActionEligibility(session, isExternalInteractionLocked);
  const sourceLabel = `${session.layerName} · ${t(`widgets.layers.selectObject.saveAs_${session.layerType}`)}`;
  const isBusy = !session.error && (session.status === 'processing' || session.status === 'committing');
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
        errorDetail={null}
        errorText={session.error}
        isBusy={isBusy}
        sourceLabel={sourceLabel}
        statusText={t(getFilterStatusTranslationKey(session.status))}
        technicalDetailsLabel={t('widgets.layers.selectObject.technicalDetails')}
        title={t('widgets.layers.rasterFilter.title')}
      />
    </ToolbarStatus>
  );
};

export const filterOperationAdapter: OperationPresentationAdapter = {
  kind: 'filter',
  modes: { component: FilterModes, width: 232 },
  more: FilterMore,
  status: FilterStatus,
};
