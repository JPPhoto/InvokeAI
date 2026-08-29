import type { CanvasLayerContract } from '@workbench/canvas-engine/api';
import type { CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';

import { Popover, Portal, Stack, Switch, Text } from '@chakra-ui/react';
import { useCanvasDocumentEditingLocked } from '@workbench/widgets/canvas/engineStoreHooks';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { AdjustmentsPopover } from './AdjustmentsPopover';
import { ControlLayerSettings } from './ControlLayerSettings';
import { InpaintMaskSettings } from './InpaintMaskSettings';
import { RasterLayerFilterSection } from './RasterLayerFilterSection';
import { RegionalGuidanceSettings } from './RegionalGuidanceSettings';

export type LayerPropertiesEngine = Pick<
  CanvasEngineHandle,
  'document' | 'exports' | 'interaction' | 'layers' | 'projectId'
>;

/** A viewport box the popover anchors to: the row's properties button, or the row itself. */
export interface LayerPropertiesAnchor {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface LayerPropertiesPopoverProps {
  anchor: LayerPropertiesAnchor;
  engine: LayerPropertiesEngine | null;
  layer: CanvasLayerContract;
  onClose: () => void;
}

/**
 * The one per-panel "properties/configure" surface: a popover holding the addressed layer's
 * type-specific settings, anchored to the row that asked for it. Rows hold no popover of their
 * own, so a large document mounts one settings instance at most. Starting a canvas operation
 * closes it before the operation panel takes over; type-specific settings are keyed by layer so
 * switching targets always mounts a fresh settings instance.
 */
export const LayerPropertiesPopover = ({ anchor, engine, layer, onClose }: LayerPropertiesPopoverProps) => {
  const editingLocked = useCanvasDocumentEditingLocked(engine);
  const documentRevision = useActiveProjectSelector((project) => project.canvas.documentRevision);
  const positioning = useMemo(() => ({ getAnchorRect: () => anchor, placement: 'left-start' as const }), [anchor]);
  const handleOpenChange = useCallback(
    (details: { open: boolean }) => {
      if (!details.open) {
        onClose();
      }
    },
    [onClose]
  );
  return (
    <Popover.Root
      lazyMount
      open={!editingLocked}
      positioning={positioning}
      unmountOnExit
      onOpenChange={handleOpenChange}
    >
      <Portal>
        <Popover.Positioner>
          <Popover.Content bg="bg.muted" borderColor="border.emphasized" borderWidth="1px" w="20rem">
            <Popover.Body p="2.5">
              <Stack gap="2">
                <LayerTypeSettings
                  documentRevision={documentRevision}
                  engine={engine}
                  layer={layer}
                  onOperationStarted={onClose}
                />
              </Stack>
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
};

/** Dispatches to the correct per-type settings block for the layer. */
const LayerTypeSettings = ({
  documentRevision,
  engine,
  layer,
  onOperationStarted,
}: {
  documentRevision: number;
  engine: LayerPropertiesEngine | null;
  layer: CanvasLayerContract;
  onOperationStarted(): void;
}) => {
  switch (layer.type) {
    case 'inpaint_mask':
      return <InpaintMaskSettings key={layer.id} engine={engine} layer={layer} />;
    case 'regional_guidance':
      return <RegionalGuidanceSettings key={layer.id} engine={engine} layer={layer} />;
    case 'control':
      return (
        <ControlLayerSettings key={layer.id} engine={engine} layer={layer} onOperationStarted={onOperationStarted} />
      );
    case 'raster':
      return (
        <RasterLayerSettings
          key={`${engine?.projectId ?? 'none'}-${layer.id}-${documentRevision}`}
          engine={engine}
          layer={layer}
          onOperationStarted={onOperationStarted}
        />
      );
  }
};

/** Raster-layer properties: transparency lock + non-destructive adjustments. */
const RasterLayerSettings = ({
  engine,
  layer,
  onOperationStarted,
}: {
  engine: LayerPropertiesEngine | null;
  layer: Extract<CanvasLayerContract, { type: 'raster' }>;
  onOperationStarted(): void;
}) => {
  const commitPrepared = usePreparedCommit(engine);
  const { t } = useTranslation();
  const isLocked = layer.isTransparencyLocked === true;

  const handleTransparencyLock = useCallback(
    (details: { checked: boolean }) => {
      commitPrepared(t('widgets.layers.adjustments.transparencyLock'), (model) =>
        model.prepare({
          before: { isTransparencyLocked: isLocked, layerType: 'raster' },
          config: { isTransparencyLocked: details.checked, layerType: 'raster' },
          id: layer.id,
          type: 'patch-config',
        })
      );
    },
    [commitPrepared, isLocked, layer.id, t]
  );

  return (
    <Stack gap="2">
      <Switch.Root checked={isLocked} size="sm" onCheckedChange={handleTransparencyLock}>
        <Switch.HiddenInput />
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <Switch.Label>
          <Text fontSize="xs">{t('widgets.layers.adjustments.transparencyLock')}</Text>
        </Switch.Label>
      </Switch.Root>
      <Text color="fg.subtle" fontSize="2xs" fontWeight="700" textTransform="uppercase">
        {t('widgets.layers.adjustments.title')}
      </Text>
      <AdjustmentsPopover engine={engine} layer={layer} />
      <RasterLayerFilterSection engine={engine} layer={layer} onOperationStarted={onOperationStarted} />
    </Stack>
  );
};
