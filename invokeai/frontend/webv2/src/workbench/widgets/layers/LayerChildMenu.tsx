import type { ComponentProps } from 'react';

import { HStack, Icon, Menu, Portal, Text } from '@chakra-ui/react';
import { MenuContent } from '@platform/ui';
import { CircleIcon, CircleOffIcon, XIcon } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { ProjectedChildRow } from './layerChildRows';
import type { LayerRowCommands, LayerSurfaceAnchor } from './layerRowCommands';

type MenuPositioning = ComponentProps<typeof Menu.Root>['positioning'];

/** The context menu of a projected child row: toggle it, or remove it. */
export const LayerChildMenu = ({
  anchor,
  child,
  commands,
  editingLocked,
  onClose,
}: {
  anchor: LayerSurfaceAnchor;
  child: ProjectedChildRow;
  commands: LayerRowCommands;
  editingLocked: boolean;
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

  return (
    <Menu.Root lazyMount open positioning={positioning} unmountOnExit onOpenChange={handleOpenChange}>
      <Portal>
        <Menu.Positioner>
          <MenuContent minW="10rem">
            <Menu.Item disabled={editingLocked} value="toggle" onSelect={handleToggle}>
              <HStack gap="2">
                <Icon as={child.isEnabled ? CircleOffIcon : CircleIcon} boxSize="3.5" color="fg.muted" />
                <Text fontSize="xs">
                  {t(child.isEnabled ? 'widgets.layers.modifiers.disable' : 'widgets.layers.modifiers.enable')}
                </Text>
              </HStack>
            </Menu.Item>
            <Menu.Item color="fg.error" disabled={editingLocked} value="remove" onSelect={handleRemove}>
              <HStack gap="2">
                <Icon as={XIcon} boxSize="3.5" />
                <Text fontSize="xs">{t('widgets.layers.regionalGuidance.removeReferenceImage')}</Text>
              </HStack>
            </Menu.Item>
          </MenuContent>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
};
