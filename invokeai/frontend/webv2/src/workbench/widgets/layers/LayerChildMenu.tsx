import type { ComponentProps } from 'react';

import { HStack, Icon, Menu, Portal, Text } from '@chakra-ui/react';
import { MenuContent } from '@platform/ui';
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CircleIcon,
  CircleOffIcon,
  CopyIcon,
  PencilIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { LayerRowCommands, LayerSurfaceAnchor } from './layerRowCommands';

import { isOrderedChildKind, layerChildRemoveLabelKey, type ProjectedChildRow } from './layerChildRows';

const ChildMenuItem = ({
  disabled,
  icon,
  label,
  tone,
  value,
  onSelect,
}: {
  disabled: boolean;
  icon: LucideIcon;
  label: string;
  tone?: 'danger';
  value: string;
  onSelect: () => void;
}) => (
  <Menu.Item color={tone === 'danger' ? 'fg.error' : undefined} disabled={disabled} value={value} onSelect={onSelect}>
    <HStack gap="2">
      <Icon as={icon} boxSize="3.5" color={tone === 'danger' ? undefined : 'fg.muted'} />
      <Text fontSize="xs">{label}</Text>
    </HStack>
  </Menu.Item>
);

type MenuPositioning = ComponentProps<typeof Menu.Root>['positioning'];

/** The context menu of a projected child row: toggle it, or remove it. */
export const LayerChildMenu = ({
  anchor,
  child,
  commands,
  editingLocked,
  moveTargets,
  onClose,
}: {
  anchor: LayerSurfaceAnchor;
  child: ProjectedChildRow;
  commands: LayerRowCommands;
  editingLocked: boolean;
  /** Other layers the item can move to (reference images), keyboard parity for the cross-layer drag. */
  moveTargets: readonly { id: string; name: string }[];
  onClose: () => void;
}) => {
  const { t } = useTranslation();
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
  const handleToggle = useCallback(() => commands.setChildEnabled(child, !child.isEnabled), [child, commands]);
  const handleRemove = useCallback(() => commands.removeChild(child), [child, commands]);
  const handleDuplicate = useCallback(() => commands.duplicateChild(child), [child, commands]);
  const handleRename = useCallback(() => commands.startRename(child.key), [child.key, commands]);
  const handleMoveUp = useCallback(() => commands.moveChild(child, -1), [child, commands]);
  const handleMoveDown = useCallback(() => commands.moveChild(child, 1), [child, commands]);
  const ordered = isOrderedChildKind(child.kind);

  return (
    <Menu.Root lazyMount open positioning={positioning} unmountOnExit onOpenChange={handleOpenChange}>
      <Portal>
        <Menu.Positioner>
          <MenuContent minW="10rem">
            <ChildMenuItem
              disabled={editingLocked}
              icon={child.isEnabled ? CircleOffIcon : CircleIcon}
              label={t(child.isEnabled ? 'widgets.layers.modifiers.disable' : 'widgets.layers.modifiers.enable')}
              value="toggle"
              onSelect={handleToggle}
            />
            {ordered ? (
              <>
                <ChildMenuItem
                  disabled={editingLocked}
                  icon={PencilIcon}
                  label={t('widgets.layers.modifiers.renameAdjustment')}
                  value="rename"
                  onSelect={handleRename}
                />
                <ChildMenuItem
                  disabled={editingLocked}
                  icon={CopyIcon}
                  label={t('widgets.layers.modifiers.duplicateAdjustment')}
                  value="duplicate"
                  onSelect={handleDuplicate}
                />
                <ChildMenuItem
                  disabled={editingLocked || child.posInSet <= 1}
                  icon={ArrowUpIcon}
                  label={t('widgets.layers.modifiers.moveUp')}
                  value="move-up"
                  onSelect={handleMoveUp}
                />
                <ChildMenuItem
                  disabled={editingLocked || child.posInSet >= child.setSize}
                  icon={ArrowDownIcon}
                  label={t('widgets.layers.modifiers.moveDown')}
                  value="move-down"
                  onSelect={handleMoveDown}
                />
              </>
            ) : null}
            {moveTargets.map((target) => (
              <MoveToLayerItem
                key={target.id}
                child={child}
                commands={commands}
                disabled={editingLocked}
                target={target}
              />
            ))}
            <ChildMenuItem
              disabled={editingLocked}
              icon={XIcon}
              label={t(layerChildRemoveLabelKey(child.kind))}
              tone="danger"
              value="remove"
              onSelect={handleRemove}
            />
          </MenuContent>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
};

const MoveToLayerItem = ({
  child,
  commands,
  disabled,
  target,
}: {
  child: ProjectedChildRow;
  commands: LayerRowCommands;
  disabled: boolean;
  target: { id: string; name: string };
}) => {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => commands.moveChildToLayer(child, target.id), [child, commands, target.id]);
  return (
    <ChildMenuItem
      disabled={disabled}
      icon={ArrowRightIcon}
      label={t('widgets.layers.modifiers.moveToLayer', { name: target.name })}
      value={`move-to:${target.id}`}
      onSelect={handleSelect}
    />
  );
};
