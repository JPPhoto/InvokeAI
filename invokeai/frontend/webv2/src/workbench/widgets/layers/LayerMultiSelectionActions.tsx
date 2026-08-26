import type { CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';

import { HStack, Text } from '@chakra-ui/react';
import { toaster } from '@platform/ui';
import { IconButton } from '@platform/ui/Button';
import { Tooltip } from '@platform/ui/Tooltip';
import {
  canMergeSelectedRasters,
  moveLayersWithinStacks,
  type CanvasLayerContract,
  type LayerStackMoveKind,
} from '@workbench/canvas-engine/api';
import { deleteLayersActions, reorderLayerActions } from '@workbench/canvasLayerOps';
import { useNotify } from '@workbench/useNotify';
import { useCanvasRasterContentEpoch } from '@workbench/widgets/canvas/engineStoreHooks';
import { reportStructuralCommit, useStructuralCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { publishLayerPanelSelection } from '@workbench/workbenchStore';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronsDownIcon,
  ChevronsUpIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  LockOpenIcon,
  MergeIcon,
  Trash2Icon,
} from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

type MultiSelectionEngine = Pick<CanvasEngineHandle, 'document' | 'exports' | 'interaction' | 'layers'>;
const BULK_TOOLTIP_POSITIONING = { placement: 'top' } as const;

interface LayerMultiSelectionActionsProps {
  editingLocked: boolean;
  engine: MultiSelectionEngine | null;
  layers: readonly CanvasLayerContract[];
  projectId: string;
  selectedIds: readonly string[];
  selectedLayerId: string | null;
}

export const LayerMultiSelectionActions = ({
  editingLocked,
  engine,
  layers,
  projectId,
  selectedIds,
  selectedLayerId,
}: LayerMultiSelectionActionsProps) => {
  const commitStructural = useStructuralCommit(engine);
  const { t } = useTranslation();
  const notify = useNotify();
  useCanvasRasterContentEpoch(engine);
  const selected = useMemo(() => {
    const ids = new Set(selectedIds);
    return layers.filter((layer) => ids.has(layer.id));
  }, [layers, selectedIds]);
  const allEnabled = selected.every((layer) => layer.isEnabled);
  const allLocked = selected.every((layer) => layer.isLocked);
  const hasLocked = selected.some((layer) => layer.isLocked);
  const canMergeSelected =
    !!engine &&
    canMergeSelectedRasters(layers, new Set(selectedIds), (layerId) =>
      engine.exports.hasExportableLayerContent(layerId)
    );

  const duplicateSelected = useCallback(async () => {
    try {
      const result = await engine?.layers.duplicateLayers(selectedIds);
      if (result?.status === 'duplicated') {
        publishLayerPanelSelection({
          primaryId: result.selectedLayerId,
          projectId,
          selectedIds: result.duplicateIds,
        });
        return;
      }
      if (result?.status === 'busy') {
        return;
      }
    } catch {
      // Reducer rejection is failure-atomic; surface the same actionable result
      // as a preflight refusal instead of leaking an event-handler exception.
    }
    if (engine) {
      toaster.create({ title: t('widgets.layers.actions.copyFailed'), type: 'warning' });
    }
  }, [engine, projectId, selectedIds, t]);

  const mergeSelected = useCallback(() => {
    if (!engine) {
      return;
    }
    void engine.layers.mergeSelectedRasterLayers(selectedIds).then((result) => {
      if (result === 'not-ready') {
        toaster.create({ title: t('widgets.layers.groupActions.mergeNotReady'), type: 'warning' });
      } else if (result === 'over-budget') {
        toaster.create({ title: t('widgets.layers.groupActions.mergeOverBudget'), type: 'warning' });
      }
    });
  }, [engine, selectedIds, t]);

  const reorder = useCallback(
    (kind: LayerStackMoveKind, label: string) => {
      const next = moveLayersWithinStacks(layers, selectedIds, kind);
      if (next.length === 0) {
        return;
      }
      const { forward, inverse } = reorderLayerActions(layers, next);
      commitStructural(label, forward, inverse);
    },
    [commitStructural, layers, selectedIds]
  );

  const moveToFront = useCallback(
    () => reorder('front', t('widgets.layers.actions.moveSelectedToFront')),
    [reorder, t]
  );
  const moveForward = useCallback(
    () => reorder('forward', t('widgets.layers.actions.moveSelectedForward')),
    [reorder, t]
  );
  const moveBackward = useCallback(
    () => reorder('backward', t('widgets.layers.actions.moveSelectedBackward')),
    [reorder, t]
  );
  const moveToBack = useCallback(() => reorder('back', t('widgets.layers.actions.moveSelectedToBack')), [reorder, t]);

  const toggleEnabled = useCallback(() => {
    const isEnabled = !allEnabled;
    commitStructural(
      t(isEnabled ? 'widgets.layers.actions.enableSelected' : 'widgets.layers.actions.disableSelected'),
      { type: 'setCanvasLayersEnabled', updates: selected.map((layer) => ({ id: layer.id, isEnabled })) },
      {
        type: 'setCanvasLayersEnabled',
        updates: selected.map((layer) => ({ id: layer.id, isEnabled: layer.isEnabled })),
      }
    );
  }, [allEnabled, commitStructural, selected, t]);

  const toggleLocked = useCallback(() => {
    const isLocked = !allLocked;
    commitStructural(
      t(isLocked ? 'widgets.layers.actions.lockSelected' : 'widgets.layers.actions.unlockSelected'),
      {
        enabledUpdates: [],
        lockedUpdates: selected.map((layer) => ({ id: layer.id, isLocked })),
        type: 'applyCanvasLayerStackMutation',
      },
      {
        enabledUpdates: [],
        lockedUpdates: selected.map((layer) => ({ id: layer.id, isLocked: layer.isLocked })),
        type: 'applyCanvasLayerStackMutation',
      }
    );
  }, [allLocked, commitStructural, selected, t]);

  const deleteSelected = useCallback(() => {
    const actions = engine ? deleteLayersActions(layers, selectedIds, selectedLayerId, engine.document) : null;
    if (!actions) {
      reportStructuralCommit({ status: engine ? 'dispatch-rejected' : 'not-ready' }, notify.error, t);
      return;
    }
    commitStructural(t('widgets.layers.actions.deleteSelected'), actions.forward, actions.inverse);
  }, [commitStructural, engine, layers, notify, selectedIds, selectedLayerId, t]);

  return (
    <HStack
      aria-label={t('widgets.layers.actions.selectedCount', { count: selected.length })}
      gap="0.5"
      minH="10"
      px="2"
      role="toolbar"
    >
      <Text color="fg.muted" flex="1" fontSize="2xs" fontWeight="700">
        {t('widgets.layers.actions.selectedCount', { count: selected.length })}
      </Text>
      <BulkActionButton
        disabled={editingLocked}
        icon={ChevronsUpIcon}
        label={t('widgets.layers.actions.moveSelectedToFront')}
        onClick={moveToFront}
      />
      <BulkActionButton
        disabled={editingLocked}
        icon={ArrowUpIcon}
        label={t('widgets.layers.actions.moveSelectedForward')}
        onClick={moveForward}
      />
      <BulkActionButton
        disabled={editingLocked}
        icon={ArrowDownIcon}
        label={t('widgets.layers.actions.moveSelectedBackward')}
        onClick={moveBackward}
      />
      <BulkActionButton
        disabled={editingLocked}
        icon={ChevronsDownIcon}
        label={t('widgets.layers.actions.moveSelectedToBack')}
        onClick={moveToBack}
      />
      <BulkActionButton
        disabled={editingLocked}
        icon={allEnabled ? EyeOffIcon : EyeIcon}
        label={t(allEnabled ? 'widgets.layers.actions.disableSelected' : 'widgets.layers.actions.enableSelected')}
        onClick={toggleEnabled}
      />
      <BulkActionButton
        disabled={editingLocked}
        icon={allLocked ? LockOpenIcon : LockIcon}
        label={t(allLocked ? 'widgets.layers.actions.unlockSelected' : 'widgets.layers.actions.lockSelected')}
        onClick={toggleLocked}
      />
      <BulkActionButton
        disabled={editingLocked || !engine}
        icon={CopyIcon}
        label={t('widgets.layers.actions.duplicateSelected')}
        onClick={duplicateSelected}
      />
      <BulkActionButton
        disabled={editingLocked || !engine || !canMergeSelected}
        icon={MergeIcon}
        label={t('widgets.layers.actions.mergeSelected')}
        onClick={mergeSelected}
      />
      <BulkActionButton
        colorPalette="red"
        disabled={editingLocked || hasLocked}
        icon={Trash2Icon}
        label={t('widgets.layers.actions.deleteSelected')}
        onClick={deleteSelected}
      />
    </HStack>
  );
};

export default LayerMultiSelectionActions;

const BulkActionButton = ({
  colorPalette,
  disabled,
  icon: Icon,
  label,
  onClick,
}: {
  colorPalette?: string;
  disabled: boolean;
  icon: typeof ArrowUpIcon;
  label: string;
  onClick: () => void;
}) => (
  <Tooltip content={label} positioning={BULK_TOOLTIP_POSITIONING}>
    <IconButton
      aria-label={label}
      colorPalette={colorPalette}
      disabled={disabled}
      size="xs"
      variant="ghost"
      onClick={onClick}
    >
      <Icon />
    </IconButton>
  </Tooltip>
);
