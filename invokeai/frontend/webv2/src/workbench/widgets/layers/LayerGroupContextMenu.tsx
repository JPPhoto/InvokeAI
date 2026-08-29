import type { CanvasGroupContract, LayerStackKind, LayerStackMoveKind } from '@workbench/canvas-engine/api';
import type { CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';
import type { LucideIcon } from 'lucide-react';
import type { ComponentProps } from 'react';

import { HStack, Icon, Menu, Portal, Text } from '@chakra-ui/react';
import { MenuContent, RenameDialog } from '@platform/ui';
import { collectSubtree, getDocumentIndex, isOverlayStack } from '@workbench/canvas-engine/api';
import { publishLayerPanelSelection, useLayerPanelState } from '@workbench/layerPanelState';
import { useNotify } from '@workbench/useNotify';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { useActiveProjectId, useActiveProjectSelector } from '@workbench/WorkbenchContext';
import {
  ArrowDownIcon,
  ArrowDownToLineIcon,
  ArrowUpIcon,
  ArrowUpToLineIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  FolderPlusIcon,
  LockIcon,
  LockOpenIcon,
  PencilIcon,
  Trash2Icon,
  UngroupIcon,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { canGroupSelection, groupLayers, ungroupLayers } from './layerGroupCommands';

export type LayerGroupContextMenuEngine = Pick<CanvasEngineHandle, 'document' | 'layers' | 'projectId'>;

type MenuPositioning = ComponentProps<typeof Menu.Root>['positioning'];

const ARRANGE: readonly { icon: LucideIcon; key: string; kind: LayerStackMoveKind }[] = [
  { icon: ArrowUpToLineIcon, key: 'moveToFront', kind: 'front' },
  { icon: ArrowUpIcon, key: 'moveForward', kind: 'forward' },
  { icon: ArrowDownIcon, key: 'moveBackward', kind: 'backward' },
  { icon: ArrowDownToLineIcon, key: 'moveToBack', kind: 'back' },
];

interface LayerGroupContextMenuProps {
  /** The viewport box the menu opens at: a row's menu button or a right-click point. */
  anchor: { x: number; y: number; width: number; height: number };
  editingLocked: boolean;
  engine: LayerGroupContextMenuEngine | null;
  group: CanvasGroupContract;
  stack: LayerStackKind;
  onClose: () => void;
}

const MenuRow = ({ icon, label }: { icon: LucideIcon; label: string }) => (
  <HStack gap="2" minW="0" w="full">
    <Icon as={icon} boxSize="3.5" color="fg.subtle" flexShrink={0} />
    <Text flex="1" fontSize="xs">
      {label}
    </Text>
  </HStack>
);

/** The group menu the panel host opens for one group at a time: naming, grouping, arrangement, and state edits. */
export const LayerGroupContextMenu = ({
  anchor,
  editingLocked,
  engine,
  group,
  onClose,
  stack,
}: LayerGroupContextMenuProps) => {
  const { t } = useTranslation();
  const commitPrepared = usePreparedCommit(engine);
  const notify = useNotify();
  const projectId = useActiveProjectId();
  const document = useActiveProjectSelector((project) => project.canvas.document);
  const { selectedIds } = useLayerPanelState(projectId, document.selectedLayerId);
  const [renaming, setRenaming] = useState(false);

  const selection = useCallback(
    (): readonly string[] => (selectedIds.includes(group.id) ? selectedIds : [group.id]),
    [group.id, selectedIds]
  );
  // What a locked ancestor or a locked descendant takes off the table, so no item leads to a refusal.
  const entry = getDocumentIndex(document).byId.get(group.id);
  const frozen = entry?.ancestorsLocked ?? false;
  const holdsLocked =
    frozen || group.isLocked || (entry ? collectSubtree(entry.node).some((node) => node.isLocked) : false);
  const groupable = canGroupSelection(engine?.document.model() ?? null, selection());
  const positioning = useMemo<MenuPositioning>(
    () => ({ getAnchorRect: () => anchor, placement: 'bottom-start' }),
    [anchor]
  );
  const handleOpenChange = useCallback(
    (details: { open: boolean }) => {
      if (!details.open) {
        onClose();
      }
    },
    [onClose]
  );

  const patch = useCallback(
    (label: string, forward: Partial<Pick<CanvasGroupContract, 'name' | 'isEnabled' | 'isLocked'>>) =>
      commitPrepared(label, (model) => model.prepare({ id: group.id, patch: forward, type: 'patch' })),
    [commitPrepared, group.id]
  );

  const handleRename = useCallback(
    (name: string) => {
      patch(t('widgets.layers.actions.rename'), { name });
    },
    [patch, t]
  );
  const openRename = useCallback(() => setRenaming(true), []);
  const closeRename = useCallback(() => setRenaming(false), []);
  const handleToggleEnabled = useCallback(
    () => patch(t('widgets.layers.actions.toggleVisibility'), { isEnabled: !group.isEnabled }),
    [group.isEnabled, patch, t]
  );
  const handleToggleLock = useCallback(
    () => patch(t('widgets.layers.actions.toggleLock'), { isLocked: !group.isLocked }),
    [group.isLocked, patch, t]
  );
  const handleToggleHidden = useCallback(
    () =>
      commitPrepared(t('widgets.layers.actions.toggleHidden'), (model) =>
        model.prepare({ type: 'set-hidden', updates: [{ id: group.id, isHidden: group.isHidden !== true }] })
      ),
    [commitPrepared, group.id, group.isHidden, t]
  );
  const handleGroup = useCallback(
    () => groupLayers(engine, projectId, selection(), t('widgets.layers.actions.group')),
    [engine, projectId, selection, t]
  );
  const handleUngroup = useCallback(
    () => ungroupLayers(engine, selection(), t('widgets.layers.actions.ungroup')),
    [engine, selection, t]
  );
  const handleDuplicate = useCallback(async () => {
    if (!engine) {
      return;
    }
    try {
      const result = await engine.layers.duplicateLayers(selection());
      if (result.status === 'duplicated') {
        publishLayerPanelSelection({ primaryId: result.selectedLayerId, projectId, selectedIds: result.duplicateIds });
        return;
      }
      if (result.status === 'busy') {
        return;
      }
    } catch {
      // The engine leaves the document unchanged on a rejected transaction.
    }
    notify.error(t('widgets.layers.actions.actionFailed'), t('widgets.layers.actions.copyFailed'));
  }, [engine, notify, projectId, selection, t]);
  const handleDelete = useCallback(
    () =>
      commitPrepared(t('widgets.layers.actions.delete'), (model) =>
        model.prepare({ ids: selection(), type: 'remove' })
      ),
    [commitPrepared, selection, t]
  );
  const handleArrange = useCallback(
    (kind: LayerStackMoveKind, label: string) => () =>
      commitPrepared(label, (model) => model.prepare({ ids: selection(), kind, type: 'move' })),
    [commitPrepared, selection]
  );

  const locked = editingLocked;
  const hideable = isOverlayStack(stack);

  const items = (
    <MenuContent minW="13rem" py="1">
      {ARRANGE.map((entry) => (
        <Menu.Item
          key={entry.kind}
          disabled={locked || frozen}
          value={entry.kind}
          onSelect={handleArrange(entry.kind, t(`widgets.layers.actions.${entry.key}`))}
        >
          <MenuRow icon={entry.icon} label={t(`widgets.layers.actions.${entry.key}`)} />
        </Menu.Item>
      ))}
      <Menu.Separator borderColor="border.subtle" />
      <Menu.Item disabled={locked} value="rename" onSelect={openRename}>
        <MenuRow icon={PencilIcon} label={t('widgets.layers.actions.rename')} />
      </Menu.Item>
      <Menu.Item disabled={locked || !engine || frozen} value="duplicate" onSelect={handleDuplicate}>
        <MenuRow icon={CopyIcon} label={t('widgets.layers.actions.duplicate')} />
      </Menu.Item>
      <Menu.Item disabled={locked || !groupable} value="group" onSelect={handleGroup}>
        <MenuRow icon={FolderPlusIcon} label={t('widgets.layers.actions.group')} />
      </Menu.Item>
      <Menu.Item disabled={locked || frozen || group.isLocked} value="ungroup" onSelect={handleUngroup}>
        <MenuRow icon={UngroupIcon} label={t('widgets.layers.actions.ungroup')} />
      </Menu.Item>
      <Menu.Separator borderColor="border.subtle" />
      <Menu.Item disabled={locked} value="enabled" onSelect={handleToggleEnabled}>
        <MenuRow
          icon={group.isEnabled ? EyeOffIcon : EyeIcon}
          label={t(group.isEnabled ? 'widgets.layers.actions.hide' : 'widgets.layers.actions.show')}
        />
      </Menu.Item>
      {hideable ? (
        <Menu.Item disabled={locked} value="hidden" onSelect={handleToggleHidden}>
          <MenuRow icon={group.isHidden ? EyeIcon : EyeOffIcon} label={t('widgets.layers.actions.toggleHidden')} />
        </Menu.Item>
      ) : null}
      <Menu.Item disabled={locked} value="lock" onSelect={handleToggleLock}>
        <MenuRow
          icon={group.isLocked ? LockOpenIcon : LockIcon}
          label={t(group.isLocked ? 'widgets.layers.actions.unlock' : 'widgets.layers.actions.lock')}
        />
      </Menu.Item>
      <Menu.Separator borderColor="border.subtle" />
      <Menu.Item color="fg.error" disabled={locked || holdsLocked} value="delete" onSelect={handleDelete}>
        <MenuRow icon={Trash2Icon} label={t('widgets.layers.actions.delete')} />
      </Menu.Item>
    </MenuContent>
  );

  return (
    <>
      <Menu.Root lazyMount open positioning={positioning} unmountOnExit onOpenChange={handleOpenChange}>
        <Portal>
          <Menu.Positioner>{items}</Menu.Positioner>
        </Portal>
      </Menu.Root>
      <RenameDialog
        initialName={group.name}
        isOpen={renaming}
        label={t('widgets.layers.actions.rename')}
        submitLabel={t('widgets.layers.actions.rename')}
        title={t('widgets.layers.actions.rename')}
        onClose={closeRename}
        onSubmit={handleRename}
      />
    </>
  );
};
