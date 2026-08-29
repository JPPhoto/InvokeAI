import type { LayerTransform } from '@workbench/canvas-engine/api';
import type { WidgetViewProps } from '@workbench/widgetContracts';

import { Flex, Stack, Text } from '@chakra-ui/react';
import { Button } from '@platform/ui';
import { getDocumentNode, lookupDocumentLeaf } from '@workbench/canvas-engine/api';
import { useCanvasHasFloatingSelection, useTransformSession } from '@workbench/widgets/canvas/engineStoreHooks';
import { ToolbarNumberField, useNumberCommit } from '@workbench/widgets/canvas/tool-presentation/ToolbarPrimitives';
import { useCanvasEngine, type CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { GroupSelectedNotice } from '@workbench/widgets/properties/GroupSelectedNotice';
import { PropertiesRow, PropertiesSection } from '@workbench/widgets/properties/PropertiesSection';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;
const MIN_SCALE_PERCENT = 1;
const round2 = (n: number): number => Math.round(n * 100) / 100;
/** Degrees in (-180, 180], so 270 reads and stores as -90. */
const wrapDegrees = (degrees: number): number => {
  const wrapped = ((((degrees + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
};
/** A flip is a negative scale; a zero or near-zero one is not a transform anyone can undo by eye. */
const clampScalePercent = (percent: number): number =>
  percent < 0 ? Math.min(percent, -MIN_SCALE_PERCENT) : Math.max(percent, MIN_SCALE_PERCENT);

interface SelectedNode {
  id: string;
  isGroup: boolean;
  locked: boolean;
  name: string;
  transform: LayerTransform | null;
}

/**
 * The selected layer's transform, editable without picking a tool: each field
 * commits one undoable document patch. While the Transform tool holds a
 * session, the same fields drive its preview and Apply / Cancel land or drop
 * it; a floating selection offers Apply / Cancel alone, since its transform is
 * layer-local rather than document space.
 */
export const TransformWidgetView = (_props: WidgetViewProps) => {
  const { t } = useTranslation();
  const engine = useCanvasEngine();

  if (!engine) {
    return (
      <Flex align="center" color="fg.muted" fontSize="xs" h="full" justify="center" p="4">
        {t('widgets.properties.noCanvas')}
      </Flex>
    );
  }
  return <ConnectedTransform engine={engine} />;
};

const ConnectedTransform = ({ engine }: { engine: CanvasEngineHandle }) => {
  const { t } = useTranslation();
  const commitPrepared = usePreparedCommit(engine);
  const session = useTransformSession(engine);
  const hasFloat = useCanvasHasFloatingSelection(engine);
  const selected = useActiveProjectSelector(
    (project): SelectedNode | null => {
      const { document } = project.canvas;
      const node = getDocumentNode(document, document.selectedLayerId);
      if (node?.type === 'group') {
        return { id: node.id, isGroup: true, locked: true, name: node.name, transform: null };
      }
      const leaf = node ? lookupDocumentLeaf(document, node.id) : null;
      return leaf
        ? {
            id: leaf.id,
            isGroup: false,
            locked: leaf.effectiveLocked,
            name: leaf.layer.name,
            transform: leaf.layer.transform,
          }
        : null;
    },
    (a, b) => a?.id === b?.id && a?.locked === b?.locked && a?.name === b?.name && a?.transform === b?.transform
  );

  const transform = session?.transform ?? selected?.transform ?? null;
  const editable = session !== null || (selected !== null && !selected.locked);
  const patch = useCallback(
    (next: Partial<LayerTransform>) => {
      if (session) {
        engine.layers.updateTransformSession({ ...session.transform, ...next });
        return;
      }
      if (!selected || selected.locked) {
        return;
      }
      commitPrepared(t('widgets.transform.edit'), (model) =>
        model.prepare({ id: selected.id, patch: { transform: next }, type: 'patch' })
      );
    },
    [commitPrepared, engine, selected, session, t]
  );
  const onX = useNumberCommit(useCallback((value: number) => patch({ x: Math.round(value) }), [patch]));
  const onY = useNumberCommit(useCallback((value: number) => patch({ y: Math.round(value) }), [patch]));
  const onScaleX = useNumberCommit(
    useCallback((value: number) => patch({ scaleX: clampScalePercent(value) / 100 }), [patch])
  );
  const onScaleY = useNumberCommit(
    useCallback((value: number) => patch({ scaleY: clampScalePercent(value) / 100 }), [patch])
  );
  const onRotation = useNumberCommit(
    useCallback((value: number) => patch({ rotation: wrapDegrees(value) * DEG_TO_RAD }), [patch])
  );
  const onApply = useCallback(() => engine.layers.applyTransform(), [engine]);
  const onCancel = useCallback(() => engine.layers.cancelTransform(), [engine]);
  const pending = session !== null || hasFloat;
  const field = (props: Omit<Parameters<typeof ToolbarNumberField>[0], 'disabled'>) => (
    <ToolbarNumberField {...props} disabled={!editable} />
  );

  return (
    <Stack gap="0">
      <PropertiesSection
        // A draft typed for one layer must not commit to the next selection.
        key={session ? 'session' : (selected?.id ?? '')}
        subtitle={session ? t('widgets.transform.session') : (selected?.name ?? t('widgets.transform.noSelection'))}
        title={t('widgets.transform.title')}
      >
        {selected?.isGroup && !session ? <GroupSelectedNotice hint={t('widgets.transform.groupSelected')} /> : null}
        <PropertiesRow label={t('widgets.transform.position')}>
          {field({
            'aria-label': t('widgets.canvas.toolOptions.positionX'),
            label: t('widgets.canvas.toolOptions.positionX'),
            value: transform ? String(Math.round(transform.x)) : '',
            onValueCommit: onX,
          })}
          {field({
            'aria-label': t('widgets.canvas.toolOptions.positionY'),
            label: t('widgets.canvas.toolOptions.positionY'),
            value: transform ? String(Math.round(transform.y)) : '',
            onValueCommit: onY,
          })}
        </PropertiesRow>
        <PropertiesRow label={t('widgets.transform.scale')}>
          {field({
            'aria-label': t('widgets.canvas.toolOptions.scaleWidth'),
            label: t('widgets.canvas.toolOptions.frameWidth'),
            suffix: '%',
            value: transform ? String(round2(transform.scaleX * 100)) : '',
            onValueCommit: onScaleX,
          })}
          {field({
            'aria-label': t('widgets.canvas.toolOptions.scaleHeight'),
            label: t('widgets.canvas.toolOptions.frameHeight'),
            suffix: '%',
            value: transform ? String(round2(transform.scaleY * 100)) : '',
            onValueCommit: onScaleY,
          })}
        </PropertiesRow>
        <PropertiesRow label={t('widgets.transform.rotation')}>
          {field({
            'aria-label': t('widgets.canvas.toolOptions.rotation'),
            suffix: '°',
            value: transform ? String(round2(wrapDegrees(transform.rotation * RAD_TO_DEG))) : '',
            onValueCommit: onRotation,
          })}
        </PropertiesRow>
        {pending ? (
          <Flex gap="2" justify="flex-end">
            <Button size="xs" variant="ghost" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
            <Button size="xs" onClick={onApply}>
              {t('common.apply')}
            </Button>
          </Flex>
        ) : (
          <Text color="fg.subtle" fontSize="2xs">
            {t('widgets.transform.hint')}
          </Text>
        )}
      </PropertiesSection>
    </Stack>
  );
};
