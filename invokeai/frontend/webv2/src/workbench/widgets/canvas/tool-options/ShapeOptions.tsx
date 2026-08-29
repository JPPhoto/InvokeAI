import type { SelectValueChangeDetails } from '@chakra-ui/react';
import type { CanvasLayerSourceContract, ShapeToolOptions } from '@workbench/canvas-engine/api';
import type {
  ToolbarRegionProps,
  ToolPresentationAdapter,
} from '@workbench/widgets/canvas/tool-presentation/toolbarContracts';

import { createListCollection } from '@chakra-ui/react';
import { ColorPicker, Select, ToggleIconButton } from '@platform/ui';
import { MAX_SHAPE_STROKE_WIDTH, getDocumentLayer } from '@workbench/canvas-engine/api';
import { useShapeOptions } from '@workbench/widgets/canvas/engineStoreHooks';
import {
  ToolbarHint,
  ToolbarNumberField,
  useNumberCommit,
} from '@workbench/widgets/canvas/tool-presentation/ToolbarPrimitives';
import { useColorSampler } from '@workbench/widgets/canvas/useColorSampler';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { PaintBucketIcon, SquareIcon } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

type ShapeSource = Extract<CanvasLayerSourceContract, { type: 'shape' }>;
type ShapeKind = ShapeToolOptions['kind'];

interface SelectedShape {
  id: string;
  source: ShapeSource;
}

const FALLBACK_COLOR = '#000000';
const SELECT_POSITIONING = { placement: 'bottom-start', sameWidth: false } as const;
const SELECT_TRIGGER_PROPS = { minW: '6rem', w: '6rem' } as const;

/**
 * Displayed values follow the selected shape layer, else the tool defaults.
 * Edits set the defaults for the next shape AND, when a shape layer is
 * selected, commit to it: colors record one history entry on release, discrete
 * edits commit at once. C2 splits these two owners into Properties sections.
 */
const useShapeEditor = (engine: ToolbarRegionProps['engine']) => {
  const { t } = useTranslation();
  const commitPrepared = usePreparedCommit(engine);
  const options = useShapeOptions(engine);
  const selected = useActiveProjectSelector(
    (project): SelectedShape | null => {
      const { document } = project.canvas;
      const layer = document.selectedLayerId ? getDocumentLayer(document, document.selectedLayerId) : undefined;
      return layer && layer.type === 'raster' && layer.source.type === 'shape'
        ? { id: layer.id, source: layer.source }
        : null;
    },
    (a, b) => a?.id === b?.id && a?.source === b?.source
  );
  const kind: ShapeKind = selected ? (selected.source.kind === 'ellipse' ? 'ellipse' : 'rect') : options.kind;
  const fill = selected ? selected.source.fill : options.fill;
  const stroke = selected ? selected.source.stroke : options.stroke;
  const strokeWidth = selected ? selected.source.strokeWidth : options.strokeWidth;

  const applyEdit = useCallback(
    (patch: Partial<ShapeToolOptions>, commit: boolean) => {
      engine.interaction.set('shapeOptions', { fill, kind, stroke, strokeWidth, ...patch });
      if (selected && commit) {
        const after: ShapeSource = { ...selected.source, ...patch };
        commitPrepared(t('widgets.canvas.toolOptions.shapeEdit'), (model) =>
          model.prepare({ id: selected.id, source: after, type: 'patch-source' })
        );
      }
    },
    [commitPrepared, engine, fill, kind, selected, stroke, strokeWidth, t]
  );
  return { applyEdit, fill, kind, stroke, strokeWidth };
};

const ShapeStrokeWidth = ({ engine }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const { applyEdit, stroke, strokeWidth } = useShapeEditor(engine);
  const onCommit = useNumberCommit(
    useCallback((value: number) => applyEdit({ strokeWidth: Math.max(0, Math.round(value)) }, true), [applyEdit])
  );
  return (
    <ToolbarNumberField
      aria-label={t('widgets.canvas.toolOptions.shapeStrokeWidth')}
      disabled={stroke === null}
      max={MAX_SHAPE_STROKE_WIDTH}
      min={0}
      suffix="px"
      value={String(Math.round(strokeWidth))}
      onValueCommit={onCommit}
    />
  );
};

const ShapeModes = ({ engine }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const { applyEdit, fill, kind, stroke } = useShapeEditor(engine);
  const kindCollection = useMemo(
    () =>
      createListCollection<{ label: string; value: ShapeKind }>({
        items: [
          { label: t('widgets.canvas.toolOptions.shapeRect'), value: 'rect' },
          { label: t('widgets.canvas.toolOptions.shapeEllipse'), value: 'ellipse' },
        ],
      }),
    [t]
  );
  const kindValue = useMemo(() => [kind], [kind]);
  const onKindChange = useCallback(
    ({ value }: SelectValueChangeDetails<{ label: string; value: ShapeKind }>) => {
      const next = value[0] as ShapeKind | undefined;
      if (next && next !== kind) {
        applyEdit({ kind: next }, true);
      }
    },
    [applyEdit, kind]
  );
  const onFillToggle = useCallback(
    (checked: boolean) => applyEdit({ fill: checked ? (fill ?? FALLBACK_COLOR) : null }, true),
    [applyEdit, fill]
  );
  const onStrokeToggle = useCallback(
    (checked: boolean) => applyEdit({ stroke: checked ? (stroke ?? FALLBACK_COLOR) : null }, true),
    [applyEdit, stroke]
  );
  return (
    <>
      <Select
        aria-label={t('widgets.canvas.toolOptions.shapeKind')}
        collection={kindCollection}
        positioning={SELECT_POSITIONING}
        size="xs"
        flexShrink={0}
        triggerProps={SELECT_TRIGGER_PROPS}
        w="6rem"
        value={kindValue}
        valueText={t(
          kind === 'ellipse' ? 'widgets.canvas.toolOptions.shapeEllipse' : 'widgets.canvas.toolOptions.shapeRect'
        )}
        onValueChange={onKindChange}
      />
      <ToggleIconButton
        checked={fill !== null}
        icon={PaintBucketIcon}
        label={t('widgets.canvas.toolOptions.shapeFill')}
        onCheckedChange={onFillToggle}
      />
      <ToggleIconButton
        checked={stroke !== null}
        icon={SquareIcon}
        label={t('widgets.canvas.toolOptions.shapeStroke')}
        onCheckedChange={onStrokeToggle}
      />
      <ToolbarHint>{t('widgets.canvas.toolOptions.shapeHint')}</ToolbarHint>
    </>
  );
};

/** Fill and stroke chips; a `none` fill or stroke shows a disabled chip so the slots keep their place. */
const ShapeColors = ({ engine }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const { applyEdit, fill, stroke } = useShapeEditor(engine);
  const sampleColor = useColorSampler(engine);
  const onFillChange = useCallback((hex: string) => applyEdit({ fill: hex }, false), [applyEdit]);
  const onFillChangeEnd = useCallback((hex: string) => applyEdit({ fill: hex }, true), [applyEdit]);
  const onStrokeChange = useCallback((hex: string) => applyEdit({ stroke: hex }, false), [applyEdit]);
  const onStrokeChangeEnd = useCallback((hex: string) => applyEdit({ stroke: hex }, true), [applyEdit]);
  return (
    <>
      <ColorPicker
        aria-label={t('widgets.canvas.toolOptions.shapeFill')}
        disabled={fill === null}
        value={fill ?? FALLBACK_COLOR}
        onSampleColor={sampleColor}
        onValueChange={onFillChange}
        onValueChangeEnd={onFillChangeEnd}
      />
      <ColorPicker
        aria-label={t('widgets.canvas.toolOptions.shapeStroke')}
        disabled={stroke === null}
        value={stroke ?? FALLBACK_COLOR}
        onSampleColor={sampleColor}
        onValueChange={onStrokeChange}
        onValueChangeEnd={onStrokeChangeEnd}
      />
    </>
  );
};

export const shapeAdapter: ToolPresentationAdapter = {
  rowLabels: {
    color: 'widgets.canvas.toolOptions.shapeColors',
    geometry: 'widgets.canvas.toolOptions.shapeStrokeWidth',
    modes: 'widgets.canvas.toolOptions.shapeKind',
  },
  color: ShapeColors,
  geometry: ShapeStrokeWidth,
  id: 'shape',
  modes: ShapeModes,
  paintsLeaf: true,
};
