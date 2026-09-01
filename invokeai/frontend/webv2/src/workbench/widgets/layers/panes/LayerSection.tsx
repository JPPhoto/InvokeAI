import type { CanvasDocumentContractV3, CanvasLayerContract } from '@workbench/canvas-engine/api';
import type { CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';

import { Stack, Switch, Text } from '@chakra-ui/react';
import { getDocumentLayer } from '@workbench/canvas-engine/api';
import { useCanvasEngine } from '@workbench/widgets/canvas/useCanvasEngine';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { AdjustmentsPopover } from '@workbench/widgets/layers/AdjustmentsPopover';
import { ControlLayerSettings } from '@workbench/widgets/layers/ControlLayerSettings';
import { InpaintMaskSettings } from '@workbench/widgets/layers/InpaintMaskSettings';
import { useLayerChildSelection } from '@workbench/widgets/layers/layerChildSelection';
import { RasterLayerFilterSection } from '@workbench/widgets/layers/RasterLayerFilterSection';
import { ReferenceImageSettings } from '@workbench/widgets/layers/ReferenceImageSettings';
import { RegionalGuidanceSettings } from '@workbench/widgets/layers/RegionalGuidanceSettings';
import { useActiveProjectId, useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { GroupSelectedNotice } from './GroupSelectedNotice';
import { PropertiesSection } from './PropertiesSection';

type LayerSectionEngine = Pick<CanvasEngineHandle, 'document' | 'exports' | 'interaction' | 'layers' | 'projectId'>;

// Reference equality is exact: the document index hands back the same node
// object until the layer itself changes, and the section renders the whole
// layer, so a narrower comparison would serve stale views of it.
const selectSelectedLayer = (project: {
  canvas: { document: Pick<CanvasDocumentContractV3, 'stacks' | 'selectedLayerId'> };
}): CanvasLayerContract | null => getDocumentLayer(project.canvas.document, project.canvas.document.selectedLayerId);

/**
 * The Layer section of the Properties pane: the selected layer's type-specific
 * settings (blend mode and opacity live in the fixed row above the tree —
 * `LayerBlendRow`). Every editor commits through the same document seams it
 * always did — this is the one implementation, reparented.
 */
export const LayerSection = ({ disabled }: { disabled: boolean }) => {
  const { t } = useTranslation();
  const engine = useCanvasEngine();
  const layer = useActiveProjectSelector(selectSelectedLayer);
  const documentRevision = useActiveProjectSelector((project) => project.canvas.documentRevision);
  // A sub-selected child row takes over the section: its own editor, its own name.
  const projectId = useActiveProjectId();
  const childSelection = useLayerChildSelection();
  const childIndex =
    layer?.type === 'regional_guidance' &&
    childSelection?.projectId === projectId &&
    childSelection.layerId === layer.id
      ? layer.referenceImages.findIndex((ref) => ref.id === childSelection.itemId)
      : -1;
  const childRefId = childIndex >= 0 ? childSelection!.itemId : null;

  return (
    <PropertiesSection
      disabled={disabled}
      subtitle={
        childRefId
          ? `${t('widgets.layers.regionalGuidance.referenceImage')} ${childIndex + 1}`
          : (layer?.name ?? t('widgets.transform.noSelection'))
      }
      title={t('widgets.properties.sections.layer')}
    >
      {layer?.type === 'regional_guidance' && childRefId ? (
        <ReferenceImageSettings key={`${layer.id}:${childRefId}`} engine={engine} layer={layer} refId={childRefId} />
      ) : layer ? (
        <LayerTypeSettings documentRevision={documentRevision} engine={engine} layer={layer} />
      ) : (
        <GroupSelectedNotice />
      )}
    </PropertiesSection>
  );
};

/** Dispatches to the correct per-type settings block for the layer. */
const LayerTypeSettings = ({
  documentRevision,
  engine,
  layer,
}: {
  documentRevision: number;
  engine: LayerSectionEngine | null;
  layer: CanvasLayerContract;
}) => {
  switch (layer.type) {
    case 'inpaint_mask':
      return <InpaintMaskSettings key={layer.id} engine={engine} layer={layer} />;
    case 'regional_guidance':
      return <RegionalGuidanceSettings key={layer.id} engine={engine} layer={layer} />;
    case 'control':
      return <ControlLayerSettings key={layer.id} engine={engine} layer={layer} onOperationStarted={noop} />;
    case 'raster':
      return (
        <RasterLayerSettings
          key={`${engine?.projectId ?? 'none'}-${layer.id}-${documentRevision}`}
          engine={engine}
          layer={layer}
        />
      );
  }
};

// Starting an operation used to close the popover; the pane's Operation
// section now simply appears above, so there is nothing to do.
const noop = (): void => undefined;

/** Raster-layer properties: transparency lock + non-destructive adjustments. */
const RasterLayerSettings = ({
  engine,
  layer,
}: {
  engine: LayerSectionEngine | null;
  layer: Extract<CanvasLayerContract, { type: 'raster' }>;
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
      <Text color="fg.muted" fontSize="2xs" fontWeight="700" textTransform="uppercase">
        {t('widgets.layers.adjustments.title')}
      </Text>
      <AdjustmentsPopover engine={engine} layer={layer} />
      <RasterLayerFilterSection engine={engine} layer={layer} onOperationStarted={noop} />
    </Stack>
  );
};
