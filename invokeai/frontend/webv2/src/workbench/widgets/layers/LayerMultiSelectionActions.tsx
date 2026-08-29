import type { CanvasDocumentContractV3, LayerStackMoveKind } from '@workbench/canvas-engine/api';
import type { CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';

import { HStack, Text } from '@chakra-ui/react';
import { toaster } from '@platform/ui';
import { IconButton } from '@platform/ui/Button';
import { Tooltip } from '@platform/ui/Tooltip';
import { canMergeSelectedRasters, getDocumentIndex } from '@workbench/canvas-engine/api';
import { publishLayerPanelSelection } from '@workbench/layerPanelState';
import { useCanvasRasterContentEpoch } from '@workbench/widgets/canvas/engineStoreHooks';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronsDownIcon,
  ChevronsUpIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  FolderMinusIcon,
  FolderPlusIcon,
  LockIcon,
  LockOpenIcon,
  MergeIcon,
  Trash2Icon,
} from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { groupLayers, ungroupLayers } from './layerGroupCommands';

type MultiSelectionEngine = Pick<CanvasEngineHandle, 'document' | 'exports' | 'interaction' | 'layers'>;
const BULK_TOOLTIP_POSITIONING = { placement: 'top' } as const;

interface LayerMultiSelectionActionsProps {
  document: CanvasDocumentContractV3;
  editingLocked: boolean;
  engine: MultiSelectionEngine | null;
  projectId: string;
  selectedIds: readonly string[];
}

export const LayerMultiSelectionActions = ({
  document,
  editingLocked,
  engine,
  projectId,
  selectedIds,
}: LayerMultiSelectionActionsProps) => {
  const commitPrepared = usePreparedCommit(engine);
  const { t } = useTranslation();
  useCanvasRasterContentEpoch(engine);
  const selected = useMemo(() => {
    const index = getDocumentIndex(document);
    return selectedIds.map((id) => index.byId.get(id)).filter((entry) => entry !== undefined);
  }, [document, selectedIds]);
  const allEnabled = selected.every((entry) => entry.node.isEnabled);
  const allLocked = selected.every((entry) => entry.node.isLocked);
  const model = engine?.document.model() ?? null;
  const none = selected.length === 0;
  // Enablement comes from the same authority that will run the command, so nothing here can refuse later.
  const canGroup =
    !none && !!model && model.refusalFor({ groupId: '\0probe', ids: selectedIds, name: '', type: 'group' }) === null;
  const canUngroup = !none && !!model && model.refusalFor({ ids: selectedIds, type: 'ungroup' }) === null;
  const canDelete = !none && !!model && model.refusalFor({ ids: selectedIds, type: 'remove' }) === null;
  const canMergeSelected =
    !!engine &&
    !!model &&
    canMergeSelectedRasters(model.document, model.compileLeaves(), new Set(selectedIds), (layerId) =>
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
      // Reducer rejection is failure-atomic; surface the same actionable result as a refusal.
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
      commitPrepared(label, (model) => model.prepare({ ids: selectedIds, kind, type: 'move' }));
    },
    [commitPrepared, selectedIds]
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
    commitPrepared(
      t(isEnabled ? 'widgets.layers.actions.enableSelected' : 'widgets.layers.actions.disableSelected'),
      (model) => model.prepare({ type: 'set-enabled', updates: selectedIds.map((id) => ({ id, isEnabled })) })
    );
  }, [allEnabled, commitPrepared, selectedIds, t]);

  const toggleLocked = useCallback(() => {
    const isLocked = !allLocked;
    commitPrepared(
      t(isLocked ? 'widgets.layers.actions.lockSelected' : 'widgets.layers.actions.unlockSelected'),
      (model) => model.prepare({ type: 'set-locked', updates: selectedIds.map((id) => ({ id, isLocked })) })
    );
  }, [allLocked, commitPrepared, selectedIds, t]);

  const groupSelected = useCallback(
    () => groupLayers(engine, projectId, selectedIds, t('widgets.layers.actions.groupSelected')),
    [engine, projectId, selectedIds, t]
  );
  const ungroupSelected = useCallback(
    () => ungroupLayers(engine, selectedIds, t('widgets.layers.actions.ungroupSelected')),
    [engine, selectedIds, t]
  );

  const deleteSelected = useCallback(() => {
    commitPrepared(t('widgets.layers.actions.deleteSelected'), (model) =>
      model.prepare({ ids: selectedIds, type: 'remove' })
    );
  }, [commitPrepared, selectedIds, t]);

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
        disabled={editingLocked || none}
        icon={ChevronsUpIcon}
        label={t('widgets.layers.actions.moveSelectedToFront')}
        onClick={moveToFront}
      />
      <BulkActionButton
        disabled={editingLocked || none}
        icon={ArrowUpIcon}
        label={t('widgets.layers.actions.moveSelectedForward')}
        onClick={moveForward}
      />
      <BulkActionButton
        disabled={editingLocked || none}
        icon={ArrowDownIcon}
        label={t('widgets.layers.actions.moveSelectedBackward')}
        onClick={moveBackward}
      />
      <BulkActionButton
        disabled={editingLocked || none}
        icon={ChevronsDownIcon}
        label={t('widgets.layers.actions.moveSelectedToBack')}
        onClick={moveToBack}
      />
      <BulkActionButton
        disabled={editingLocked || !engine || !canGroup}
        icon={FolderPlusIcon}
        label={t('widgets.layers.actions.groupSelected')}
        onClick={groupSelected}
      />
      <BulkActionButton
        disabled={editingLocked || !engine || !canUngroup}
        icon={FolderMinusIcon}
        label={t('widgets.layers.actions.ungroupSelected')}
        onClick={ungroupSelected}
      />
      <BulkActionButton
        disabled={editingLocked || none}
        icon={allEnabled ? EyeOffIcon : EyeIcon}
        label={t(allEnabled ? 'widgets.layers.actions.disableSelected' : 'widgets.layers.actions.enableSelected')}
        onClick={toggleEnabled}
      />
      <BulkActionButton
        disabled={editingLocked || none}
        icon={allLocked ? LockOpenIcon : LockIcon}
        label={t(allLocked ? 'widgets.layers.actions.unlockSelected' : 'widgets.layers.actions.lockSelected')}
        onClick={toggleLocked}
      />
      <BulkActionButton
        disabled={editingLocked || !engine || none}
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
        disabled={editingLocked || !canDelete}
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
