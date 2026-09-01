import type { CanvasDocumentContractV3, CanvasLayerContract } from '@workbench/canvas-engine/api';
import type { CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';

import { Stack, Switch, Text } from '@chakra-ui/react';
import { getDocumentLayer } from '@workbench/canvas-engine/api';
import { useCanvasEngine } from '@workbench/widgets/canvas/useCanvasEngine';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { AdjustmentsPopover } from '@workbench/widgets/layers/AdjustmentsPopover';
import { ControlLayerSettings } from '@workbench/widgets/layers/ControlLayerSettings';
import { InpaintMaskSettings } from '@workbench/widgets/layers/InpaintMaskSettings';
import { MASK_DENOISE_ITEM_ID, MASK_NOISE_ITEM_ID } from '@workbench/widgets/layers/layerChildRows';
import { useLayerChildSelection } from '@workbench/widgets/layers/layerChildSelection';
import { MaskModifierSettings } from '@workbench/widgets/layers/MaskModifierSettings';
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
  const child = resolveChildEditor(layer, childSelection?.projectId === projectId ? childSelection : null, t);

  return (
    <PropertiesSection
      disabled={disabled}
      subtitle={child ? child.subtitle : (layer?.name ?? t('widgets.transform.noSelection'))}
      title={t('widgets.properties.sections.layer')}
    >
      {child && layer ? (
        <ChildEditor key={`${layer.id}:${child.itemId}`} child={child} engine={engine} layer={layer} />
      ) : layer ? (
        <LayerTypeSettings documentRevision={documentRevision} engine={engine} layer={layer} />
      ) : (
        <GroupSelectedNotice />
      )}
    </PropertiesSection>
  );
};

interface ChildEditorTarget {
  readonly kind: 'reference-image' | 'mask-noise' | 'mask-denoise';
  readonly itemId: string;
  readonly subtitle: string;
}

/** What the sub-selection edits, or `null` when it does not belong to `layer`. */
const resolveChildEditor = (
  layer: CanvasLayerContract | null,
  selection: { layerId: string; itemId: string } | null,
  t: (key: string) => string
): ChildEditorTarget | null => {
  if (!layer || !selection || selection.layerId !== layer.id) {
    return null;
  }
  if (layer.type === 'regional_guidance') {
    const index = layer.referenceImages.findIndex((ref) => ref.id === selection.itemId);
    return index >= 0
      ? {
          itemId: selection.itemId,
          kind: 'reference-image',
          subtitle: `${t('widgets.layers.regionalGuidance.referenceImage')} ${index + 1}`,
        }
      : null;
  }
  if (layer.type === 'inpaint_mask') {
    if (selection.itemId === MASK_NOISE_ITEM_ID && layer.noise) {
      return { itemId: selection.itemId, kind: 'mask-noise', subtitle: t('widgets.layers.modifiers.noise') };
    }
    if (selection.itemId === MASK_DENOISE_ITEM_ID && layer.denoise) {
      return { itemId: selection.itemId, kind: 'mask-denoise', subtitle: t('widgets.layers.modifiers.denoise') };
    }
  }
  return null;
};

const ChildEditor = ({
  child,
  engine,
  layer,
}: {
  child: ChildEditorTarget;
  engine: LayerSectionEngine | null;
  layer: CanvasLayerContract;
}) => {
  if (child.kind === 'reference-image' && layer.type === 'regional_guidance') {
    return <ReferenceImageSettings engine={engine} layer={layer} refId={child.itemId} />;
  }
  if ((child.kind === 'mask-noise' || child.kind === 'mask-denoise') && layer.type === 'inpaint_mask') {
    return <MaskModifierSettings engine={engine} kind={child.kind} layer={layer} />;
  }
  return null;
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
