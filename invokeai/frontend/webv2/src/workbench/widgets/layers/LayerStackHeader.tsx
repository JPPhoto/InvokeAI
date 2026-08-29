import type { CanvasDocumentContractV3, LayerStackKind } from '@workbench/canvas-engine/api';
import type { CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';
import type { LucideIcon } from 'lucide-react';

import { HStack, Icon, Text } from '@chakra-ui/react';
import { IconButton, toaster, Tooltip } from '@platform/ui';
import { canMergeVisibleRasters, compileDocumentNodes, getDocumentLeaves } from '@workbench/canvas-engine/api';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { useActiveProjectName } from '@workbench/WorkbenchContext';
import { ChevronDownIcon, EyeIcon, EyeOffIcon, FileDownIcon, LayersIcon, PlusIcon } from 'lucide-react';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { stackAddItemId } from './addLayerMenu';
import {
  canExportRasterPsd,
  getStackActions,
  isStackAllVisible,
  planStackVisibilityToggle,
  stackVisibilityAxis,
} from './layerStackActions';
import { getPsdExportNoticeKey } from './psdExportNotice';
import { useAddLayer } from './useAddLayer';

export type LayerStackHeaderEngine = Pick<CanvasEngineHandle, 'document' | 'exports' | 'interaction' | 'layers'>;

interface LayerStackHeaderProps {
  collapsed: boolean;
  document: CanvasDocumentContractV3;
  editingLocked: boolean;
  engine: LayerStackHeaderEngine | null;
  leafCount: number;
  stack: LayerStackKind;
  onToggleCollapse: (stack: LayerStackKind) => void;
}

/** One stack's header row: chevron, name, count, and the right-aligned action cluster. */
const LayerStackHeaderComponent = ({
  collapsed,
  document,
  editingLocked,
  engine,
  leafCount,
  stack,
  onToggleCollapse,
}: LayerStackHeaderProps) => {
  const { t } = useTranslation();
  const handleToggle = useCallback(() => onToggleCollapse(stack), [onToggleCollapse, stack]);
  return (
    <HStack bg="bg.panel" gap="1" h="full" px="2.5">
      <IconButton
        aria-label={t(collapsed ? 'widgets.layers.groupActions.expand' : 'widgets.layers.groupActions.collapse')}
        color="fg.subtle"
        size="2xs"
        variant="ghost"
        onClick={handleToggle}
      >
        <Icon
          as={ChevronDownIcon}
          boxSize="3.5"
          transform={collapsed ? 'rotate(-90deg)' : undefined}
          transitionDuration="fast"
          transitionProperty="transform"
        />
      </IconButton>
      <Text
        color="fg.muted"
        cursor="pointer"
        flex="1"
        fontSize="2xs"
        fontWeight="700"
        textTransform="uppercase"
        truncate
        userSelect="none"
        onClick={handleToggle}
      >
        {t(`widgets.layers.groups.${stack}`)} ({leafCount})
      </Text>
      <StackActions document={document} editingLocked={editingLocked} engine={engine} stack={stack} />
    </HStack>
  );
};

export const LayerStackHeader = memo(LayerStackHeaderComponent);

/** The right-aligned stack-header action cluster; the set of actions is data (`getStackActions`). */
const StackActions = ({
  document,
  editingLocked,
  engine,
  stack,
}: {
  document: CanvasDocumentContractV3;
  editingLocked: boolean;
  engine: LayerStackHeaderEngine | null;
  stack: LayerStackKind;
}) => {
  const commitPrepared = usePreparedCommit(engine);
  const { t } = useTranslation();
  const addLayer = useAddLayer();
  const projectName = useActiveProjectName();
  const axis = stackVisibilityAxis(stack);
  const nodes = compileDocumentNodes(document).filter((node) => node.stack === stack);
  const allVisible = isStackAllVisible(nodes, axis);
  const canMerge =
    !editingLocked &&
    !!engine &&
    stack === 'raster' &&
    canMergeVisibleRasters(engine.document.model()?.compileLeaves() ?? [], engine.exports.hasExportableLayerContent);
  const canExport = !!engine && stack === 'raster' && canExportRasterPsd(getDocumentLeaves(document));

  const handleNew = useCallback(() => addLayer(stackAddItemId(stack)), [addLayer, stack]);
  const handleToggleVisibility = useCallback(() => {
    const { ids, nextVisible } = planStackVisibilityToggle(nodes, axis);
    if (ids.length === 0) {
      return;
    }
    if (axis === 'hidden') {
      commitPrepared(t('widgets.layers.groupActions.toggleHidden'), (model) =>
        model.prepare({ type: 'set-hidden', updates: ids.map((id) => ({ id, isHidden: !nextVisible })) })
      );
      return;
    }
    commitPrepared(t('widgets.layers.groupActions.toggleVisibility'), (model) =>
      model.prepare({ type: 'set-enabled', updates: ids.map((id) => ({ id, isEnabled: nextVisible })) })
    );
  }, [axis, commitPrepared, nodes, t]);
  const handleMergeVisible = useCallback(() => {
    if (!engine) {
      return;
    }
    void engine.layers.mergeVisibleRasterLayers().then((result) => {
      if (result === 'not-ready') {
        toaster.create({ title: t('widgets.layers.groupActions.mergeNotReady'), type: 'warning' });
      } else if (result === 'over-budget') {
        toaster.create({ title: t('widgets.layers.groupActions.mergeOverBudget'), type: 'warning' });
      }
    });
  }, [engine, t]);
  const handleExportPsd = useCallback(async () => {
    if (!engine) {
      return;
    }
    try {
      const noticeKey = getPsdExportNoticeKey(await engine.exports.exportRasterLayersToPsd(projectName));
      if (noticeKey) {
        toaster.create({ title: t(noticeKey), type: 'warning' });
      }
    } catch {
      toaster.create({ title: t('widgets.layers.groupActions.exportFailed'), type: 'error' });
    }
  }, [engine, projectName, t]);

  return (
    <HStack gap="0.5">
      {getStackActions(stack).map((action) => {
        switch (action) {
          case 'mergeVisible':
            return (
              <StackActionButton
                key={action}
                disabled={!canMerge}
                icon={LayersIcon}
                label={t('widgets.layers.groupActions.mergeVisible')}
                onClick={handleMergeVisible}
              />
            );
          case 'exportPsd':
            return (
              <StackActionButton
                key={action}
                disabled={editingLocked || !canExport}
                icon={FileDownIcon}
                label={t('widgets.layers.groupActions.exportPsd')}
                onClick={handleExportPsd}
              />
            );
          case 'toggleVisibility':
            return (
              <StackActionButton
                key={action}
                disabled={editingLocked}
                icon={allVisible ? EyeIcon : EyeOffIcon}
                label={t(allVisible ? 'widgets.layers.groupActions.hideAll' : 'widgets.layers.groupActions.showAll')}
                onClick={handleToggleVisibility}
              />
            );
          case 'new':
            return (
              <StackActionButton
                key={action}
                disabled={editingLocked}
                icon={PlusIcon}
                label={t('widgets.layers.groupActions.new')}
                onClick={handleNew}
              />
            );
        }
      })}
    </HStack>
  );
};

const StackActionButton = ({
  disabled,
  icon,
  label,
  onClick,
}: {
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) => (
  <Tooltip content={label}>
    <IconButton aria-label={label} color="fg.subtle" disabled={disabled} size="2xs" variant="ghost" onClick={onClick}>
      <Icon as={icon} boxSize="3.5" />
    </IconButton>
  </Tooltip>
);
