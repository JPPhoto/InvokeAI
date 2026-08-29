import type { CanvasDocumentContractV3, LayerStackMoveKind } from '@workbench/canvas-engine/api';
import type { CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';
import type { KeyboardEvent } from 'react';

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
import { useCallback, useMemo, useState } from 'react';
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

  const actions = useMemo<readonly BulkAction[]>(
    () => [
      {
        disabled: editingLocked || none,
        icon: ChevronsUpIcon,
        id: 'front',
        label: t('widgets.layers.actions.moveSelectedToFront'),
        run: moveToFront,
      },
      {
        disabled: editingLocked || none,
        icon: ArrowUpIcon,
        id: 'forward',
        label: t('widgets.layers.actions.moveSelectedForward'),
        run: moveForward,
      },
      {
        disabled: editingLocked || none,
        icon: ArrowDownIcon,
        id: 'backward',
        label: t('widgets.layers.actions.moveSelectedBackward'),
        run: moveBackward,
      },
      {
        disabled: editingLocked || none,
        icon: ChevronsDownIcon,
        id: 'back',
        label: t('widgets.layers.actions.moveSelectedToBack'),
        run: moveToBack,
      },
      {
        disabled: editingLocked || !engine || !canGroup,
        icon: FolderPlusIcon,
        id: 'group',
        label: t('widgets.layers.actions.groupSelected'),
        run: groupSelected,
      },
      {
        disabled: editingLocked || !engine || !canUngroup,
        icon: FolderMinusIcon,
        id: 'ungroup',
        label: t('widgets.layers.actions.ungroupSelected'),
        run: ungroupSelected,
      },
      {
        disabled: editingLocked || none,
        icon: allEnabled ? EyeOffIcon : EyeIcon,
        id: 'enable',
        label: t(allEnabled ? 'widgets.layers.actions.disableSelected' : 'widgets.layers.actions.enableSelected'),
        run: toggleEnabled,
      },
      {
        disabled: editingLocked || none,
        icon: allLocked ? LockOpenIcon : LockIcon,
        id: 'lock',
        label: t(allLocked ? 'widgets.layers.actions.unlockSelected' : 'widgets.layers.actions.lockSelected'),
        run: toggleLocked,
      },
      {
        disabled: editingLocked || !engine || none,
        icon: CopyIcon,
        id: 'duplicate',
        label: t('widgets.layers.actions.duplicateSelected'),
        run: duplicateSelected,
      },
      {
        disabled: editingLocked || !engine || !canMergeSelected,
        icon: MergeIcon,
        id: 'merge',
        label: t('widgets.layers.actions.mergeSelected'),
        run: mergeSelected,
      },
      {
        colorPalette: 'red',
        disabled: editingLocked || !canDelete,
        icon: Trash2Icon,
        id: 'delete',
        label: t('widgets.layers.actions.deleteSelected'),
        run: deleteSelected,
      },
    ],
    [
      allEnabled,
      allLocked,
      canDelete,
      canGroup,
      canMergeSelected,
      canUngroup,
      deleteSelected,
      duplicateSelected,
      editingLocked,
      engine,
      groupSelected,
      mergeSelected,
      moveBackward,
      moveForward,
      moveToBack,
      moveToFront,
      none,
      t,
      toggleEnabled,
      toggleLocked,
      ungroupSelected,
    ]
  );
  return (
    <BulkActionToolbar
      actions={actions}
      label={t('widgets.layers.actions.selectedCount', { count: selected.length })}
    />
  );
};

export default LayerMultiSelectionActions;

interface BulkAction {
  colorPalette?: string;
  disabled: boolean;
  icon: typeof ArrowUpIcon;
  id: string;
  label: string;
  run: () => void;
}

/**
 * One tab stop for the whole toolbar; arrows, Home and End move between the enabled buttons. The focus
 * bookkeeping lives here so tracking it never re-runs the eligibility above.
 */
const BulkActionToolbar = ({ actions, label }: { actions: readonly BulkAction[]; label: string }) => {
  const [activeId, setActiveId] = useState<string | null>(null);
  const enabled = actions.filter((action) => !action.disabled);
  const tabStopId = enabled.some((action) => action.id === activeId) ? activeId : (enabled[0]?.id ?? null);
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return;
    }
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const current = buttons.indexOf(event.target as HTMLButtonElement);
    if (buttons.length === 0 || current === -1) {
      return;
    }
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length;
    buttons[next]!.focus();
  }, []);
  return (
    <HStack aria-label={label} gap="0.5" minH="10" px="2" role="toolbar" onKeyDown={onKeyDown}>
      <Text color="fg.muted" flex="1" fontSize="2xs" fontWeight="700">
        {label}
      </Text>
      {actions.map((action) => (
        <BulkActionButton
          key={action.id}
          action={action}
          tabIndex={action.id === tabStopId ? 0 : -1}
          onFocus={setActiveId}
        />
      ))}
    </HStack>
  );
};

const BulkActionButton = ({
  action: { colorPalette, disabled, icon: Icon, id, label, run },
  onFocus,
  tabIndex,
}: {
  action: BulkAction;
  onFocus: (id: string) => void;
  tabIndex: number;
}) => {
  const handleFocus = useCallback(() => onFocus(id), [id, onFocus]);
  return (
    <Tooltip content={label} positioning={BULK_TOOLTIP_POSITIONING}>
      <IconButton
        aria-label={label}
        colorPalette={colorPalette}
        disabled={disabled}
        size="xs"
        tabIndex={tabIndex}
        variant="ghost"
        onClick={run}
        onFocus={handleFocus}
      >
        <Icon />
      </IconButton>
    </Tooltip>
  );
};
