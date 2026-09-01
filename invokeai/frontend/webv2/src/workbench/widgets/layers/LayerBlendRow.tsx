import type { NumberInput as ChakraNumberInput, SelectValueChangeDetails } from '@chakra-ui/react';
import type {
  CanvasBlendMode,
  CanvasDocumentContractV3,
  CanvasLayerContract,
  CanvasMaskFillContract,
} from '@workbench/canvas-engine/api';
import type { CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';

import { Box, createListCollection, Flex, HStack, NumberInput } from '@chakra-ui/react';
import { ColorPicker, Field, Select } from '@platform/ui';
import { getDocumentLayer } from '@workbench/canvas-engine/api';
import { useCanvasDocumentEditingLocked } from '@workbench/widgets/canvas/engineStoreHooks';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { applyStructuralPreview, CANVAS_BLEND_MODES } from '@workbench/widgets/layers/layerOps';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

type LayerBlendRowEngine = Pick<CanvasEngineHandle, 'document' | 'exports' | 'interaction' | 'layers' | 'projectId'>;

const SELECT_POSITIONING = { placement: 'bottom-start', sameWidth: true } as const;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** A mask layer whose fill colour the row's swatch edits (inpaint mask / region). */
type MaskLayer = Extract<CanvasLayerContract, { type: 'inpaint_mask' | 'regional_guidance' }>;

const isMaskLayer = (layer: CanvasLayerContract | null): layer is MaskLayer =>
  layer !== null && (layer.type === 'inpaint_mask' || layer.type === 'regional_guidance');

// Reference equality is exact: the document index hands back the same node
// object until the layer itself changes.
const selectSelectedLayer = (project: {
  canvas: { document: Pick<CanvasDocumentContractV3, 'stacks' | 'selectedLayerId'> };
}): CanvasLayerContract | null => getDocumentLayer(project.canvas.document, project.canvas.document.selectedLayerId);

export const isLayerEditingDisabled = (layer: CanvasLayerContract | null, editingLocked: boolean): boolean =>
  !layer || editingLocked;

/**
 * The fixed blend-mode + opacity row above the layer tree, Photoshop-style. It
 * edits the selected layer and simply disables without one — the row never
 * appears or disappears.
 */
export const LayerBlendRow = ({ engine }: { engine: LayerBlendRowEngine | null }) => {
  const layer = useActiveProjectSelector(selectSelectedLayer);
  const editingLocked = useCanvasDocumentEditingLocked(engine);

  return (
    <Flex align="center" flexShrink={0} gap="2" px="2" py="1">
      <BlendModeControl editingLocked={editingLocked} engine={engine} layer={layer} />
      <OpacityRow editingLocked={editingLocked} engine={engine} layer={layer} />
    </Flex>
  );
};

interface BlendModeOption {
  label: string;
  value: CanvasBlendMode;
}

const BlendModeControl = ({
  editingLocked,
  engine,
  layer,
}: {
  editingLocked: boolean;
  engine: LayerBlendRowEngine | null;
  layer: CanvasLayerContract | null;
}) => {
  const commitPrepared = usePreparedCommit(engine);
  const { t } = useTranslation();
  const disabled = isLayerEditingDisabled(layer, editingLocked);
  const blendMode = layer?.blendMode ?? 'normal';
  const blendCollection = useMemo(
    () =>
      createListCollection<BlendModeOption>({
        items: CANVAS_BLEND_MODES.map((mode) => ({ label: t(`widgets.layers.blendModes.${mode}`), value: mode })),
      }),
    [t]
  );
  const blendValue = useMemo(() => [blendMode], [blendMode]);

  const handleBlendChange = useCallback(
    ({ value }: SelectValueChangeDetails<BlendModeOption>) => {
      const mode = value[0] as CanvasBlendMode | undefined;
      if (!layer || !mode || mode === layer.blendMode) {
        return;
      }
      commitPrepared(t('widgets.layers.actions.blendMode'), (model) =>
        model.prepare({ id: layer.id, patch: { blendMode: mode }, type: 'patch' })
      );
    },
    [commitPrepared, layer, t]
  );

  return (
    <Field disabled={disabled} flex="1.5" label={t('widgets.layers.actions.blendMode')} orientation="horizontal">
      <Select
        aria-label={t('widgets.layers.actions.blendMode')}
        collection={blendCollection}
        disabled={disabled}
        minW="7rem"
        positioning={SELECT_POSITIONING}
        size="xs"
        value={blendValue}
        valueText={t(`widgets.layers.blendModes.${blendMode}`)}
        w="full"
        onValueChange={handleBlendChange}
      />
    </Field>
  );
};

const OpacityRow = ({
  editingLocked,
  engine,
  layer,
}: {
  editingLocked: boolean;
  engine: LayerBlendRowEngine | null;
  layer: CanvasLayerContract | null;
}) => {
  const commitPrepared = usePreparedCommit(engine);
  const { t } = useTranslation();
  // The uncommitted opacity edit: captured once per gesture. `before` is the
  // pre-gesture value (the undo target); `latest` tracks the live value because
  // React may not have re-rendered between the live dispatch and the commit
  // trigger (both can fire inside one browser event), so `layer.opacity` from the
  // render closure can be stale at commit time.
  const pendingRef = useRef<{ id: string; before: number; latest: number } | null>(null);
  const disabled = isLayerEditingDisabled(layer, editingLocked);
  const opacityPercent = useMemo(() => String(Math.round((layer?.opacity ?? 1) * 100)), [layer?.opacity]);

  // Records ONE history entry spanning the pending gesture (a spinner press,
  // an arrow-key press, or a typed value committed via Enter/blur).
  const commitPending = useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending || pending.before === pending.latest) {
      return;
    }
    commitPrepared(t('widgets.layers.actions.opacity'), (model) =>
      model.prepare({
        before: { opacity: pending.before },
        id: pending.id,
        patch: { opacity: pending.latest },
        type: 'patch',
      })
    );
  }, [commitPrepared, t]);

  const handleOpacityChange = useCallback(
    ({ valueAsNumber }: ChakraNumberInput.ValueChangeDetails) => {
      if (!layer || !Number.isFinite(valueAsNumber)) {
        return;
      }
      // If a pending edit belongs to a previously selected layer, flush it first
      // so its history entry is never attributed to the new layer.
      if (pendingRef.current && pendingRef.current.id !== layer.id) {
        commitPending();
      }
      const next = clamp01(valueAsNumber / 100);
      if (
        !applyStructuralPreview(engine, {
          id: layer.id,
          patch: { opacity: next },
          type: 'updateCanvasLayer',
        })
      ) {
        return;
      }
      if (pendingRef.current === null) {
        pendingRef.current = { before: layer.opacity, id: layer.id, latest: next };
      } else {
        pendingRef.current.latest = next;
      }
    },
    [commitPending, engine, layer]
  );

  // Commit per completed interaction: each spinner click (fires on release, so a
  // press-and-hold repeat is one gesture), each arrow/paging key release, Enter,
  // and blur (typed values).
  const handleInputKeyUp = useCallback(
    (event: { key: string }) => {
      if (['ArrowDown', 'ArrowUp', 'End', 'Enter', 'Home', 'PageDown', 'PageUp'].includes(event.key)) {
        commitPending();
      }
    },
    [commitPending]
  );

  // Flush a still-pending edit if the row unmounts mid-gesture (e.g. the panel
  // closes right after a spinner click) so the edit is never lost to history.
  const flushOnUnmountRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) {
        return () => commitPending();
      }
      return undefined;
    },
    [commitPending]
  );

  return (
    <Field disabled={disabled} label={t('widgets.layers.actions.opacity')} orientation="horizontal">
      <HStack ref={flushOnUnmountRef} gap="2">
        <NumberInput.Root
          disabled={disabled}
          max={100}
          min={0}
          size="xs"
          step={1}
          value={opacityPercent}
          w="20"
          onValueChange={handleOpacityChange}
        >
          <NumberInput.Control onClick={commitPending} />
          <NumberInput.Input
            aria-label={t('widgets.layers.actions.opacity')}
            onBlur={commitPending}
            onKeyUp={handleInputKeyUp}
          />
        </NumberInput.Root>
        {isMaskLayer(layer) ? <MaskFillSwatch disabled={editingLocked} engine={engine} layer={layer} /> : null}
      </HStack>
    </Field>
  );
};

/**
 * The selected mask layer's fill-colour swatch (legacy `ActionBarFill`): a colour
 * swatch that opens the picker. Live edits during the drag are un-recorded; the
 * final colour lands as one undoable history entry, mirroring the slider pattern.
 */
const MaskFillSwatch = ({
  disabled,
  engine,
  layer,
}: {
  disabled: boolean;
  engine: LayerBlendRowEngine | null;
  layer: MaskLayer;
}) => {
  const commitPrepared = usePreparedCommit(engine);
  const { t } = useTranslation();
  const fillBeforeRef = useRef<CanvasMaskFillContract | null>(null);
  const fill = layer.mask.fill;

  const patchFill = useCallback(
    (next: CanvasMaskFillContract, before: CanvasMaskFillContract) => {
      const configFor = (value: CanvasMaskFillContract) =>
        layer.type === 'inpaint_mask'
          ? ({ layerType: 'inpaint_mask', mask: { fill: value } } as const)
          : ({ layerType: 'regional_guidance', mask: { fill: value } } as const);
      commitPrepared(t('widgets.layers.maskFill.fill'), (model) =>
        model.prepare({ before: configFor(before), config: configFor(next), id: layer.id, type: 'patch-config' })
      );
    },
    [commitPrepared, layer.id, layer.type, t]
  );

  const handleColorChange = useCallback(
    (hex: string) => {
      const next = { ...fill, color: hex };
      const config =
        layer.type === 'inpaint_mask'
          ? ({ layerType: 'inpaint_mask', mask: { fill: next } } as const)
          : ({ layerType: 'regional_guidance', mask: { fill: next } } as const);
      if (!applyStructuralPreview(engine, { config, id: layer.id, type: 'updateCanvasLayerConfig' })) {
        return;
      }
      if (fillBeforeRef.current === null) {
        fillBeforeRef.current = fill;
      }
    },
    [engine, fill, layer.id, layer.type]
  );

  const handleColorChangeEnd = useCallback(
    (hex: string) => {
      const before = fillBeforeRef.current ?? fill;
      fillBeforeRef.current = null;
      patchFill({ ...before, color: hex }, before);
    },
    [fill, patchFill]
  );

  return (
    <Box aria-disabled={disabled} inert={disabled} opacity={disabled ? 0.5 : 1}>
      <ColorPicker
        aria-label={t('widgets.layers.maskFill.color')}
        value={fill.color}
        onValueChange={handleColorChange}
        onValueChangeEnd={handleColorChangeEnd}
      />
    </Box>
  );
};
