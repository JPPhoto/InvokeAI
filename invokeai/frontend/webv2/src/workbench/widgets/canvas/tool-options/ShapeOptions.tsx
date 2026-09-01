import type { SelectValueChangeDetails } from '@chakra-ui/react';
import type { CanvasLayerSourceContract, ShapeToolOptions } from '@workbench/canvas-engine/api';
import type {
  ToolbarRegionProps,
  ToolPresentationAdapter,
} from '@workbench/widgets/canvas/tool-presentation/toolbarContracts';

import { createListCollection } from '@chakra-ui/react';
import { ToggleIconButton } from '@platform/ui/Button';
import { ColorPicker } from '@platform/ui/ColorPicker';
import { Select } from '@platform/ui/Select';
import { MAX_SHAPE_STROKE_WIDTH, getDocumentLayer } from '@workbench/canvas-engine/api';
import { useActiveColorCommands, useActiveColorPair } from '@workbench/widgets/canvas/color-system/useActiveColors';
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
 * Displayed values follow the selected shape layer, else the creation defaults
 * — kind/width/enablement from the tool options and colors from the active
 * pair (fill = foreground, stroke = background). A selected shape's edits
 * commit to the document (colors record one history entry on release); with
 * nothing selected the color chips edit the pair itself, so there is no second
 * global shape color.
 */
const useShapeEditor = (engine: ToolbarRegionProps['engine']) => {
  const { t } = useTranslation();
  const commitPrepared = usePreparedCommit(engine);
  const options = useShapeOptions(engine);
  const pair = useActiveColorPair();
  const colorCommands = useActiveColorCommands();
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
  const fill = selected ? selected.source.fill : options.fillEnabled ? pair.foreground : null;
  const stroke = selected ? selected.source.stroke : options.strokeEnabled ? pair.background : null;
  const strokeWidth = selected ? selected.source.strokeWidth : options.strokeWidth;

  const commitSource = useCallback(
    (patch: Partial<ShapeSource>) => {
      if (!selected) {
        return;
      }
      const after: ShapeSource = { ...selected.source, ...patch };
      commitPrepared(t('widgets.canvas.toolOptions.shapeEdit'), (model) =>
        model.prepare({ id: selected.id, source: after, type: 'patch-source' })
      );
    },
    [commitPrepared, selected, t]
  );
  const setOptions = useCallback(
    (patch: Partial<ShapeToolOptions>) => {
      engine.interaction.set('shapeOptions', { ...options, ...patch });
    },
    [engine, options]
  );
  const setKind = useCallback(
    (next: ShapeKind) => {
      setOptions({ kind: next });
      commitSource({ kind: next });
    },
    [commitSource, setOptions]
  );
  const setStrokeWidth = useCallback(
    (value: number) => {
      setOptions({ strokeWidth: value });
      commitSource({ strokeWidth: value });
    },
    [commitSource, setOptions]
  );
  const setFillEnabled = useCallback(
    (checked: boolean) => {
      setOptions({ fillEnabled: checked });
      commitSource({ fill: checked ? (selected?.source.fill ?? pair.foreground) : null });
    },
    [commitSource, pair.foreground, selected, setOptions]
  );
  const setStrokeEnabled = useCallback(
    (checked: boolean) => {
      setOptions({ strokeEnabled: checked });
      commitSource({ stroke: checked ? (selected?.source.stroke ?? pair.background) : null });
    },
    [commitSource, pair.background, selected, setOptions]
  );
  const setFillColor = useCallback(
    (hex: string, commit: boolean) => {
      if (selected) {
        if (commit) {
          commitSource({ fill: hex });
        }
        return;
      }
      colorCommands.setPairColor('foreground', hex);
    },
    [colorCommands, commitSource, selected]
  );
  const setStrokeColor = useCallback(
    (hex: string, commit: boolean) => {
      if (selected) {
        if (commit) {
          commitSource({ stroke: hex });
        }
        return;
      }
      colorCommands.setPairColor('background', hex);
    },
    [colorCommands, commitSource, selected]
  );
  return {
    fill,
    kind,
    setFillColor,
    setFillEnabled,
    setKind,
    setStrokeColor,
    setStrokeEnabled,
    setStrokeWidth,
    stroke,
    strokeWidth,
  };
};

const ShapeStrokeWidth = ({ engine }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const { setStrokeWidth, stroke, strokeWidth } = useShapeEditor(engine);
  const onCommit = useNumberCommit(
    useCallback((value: number) => setStrokeWidth(Math.max(0, Math.round(value))), [setStrokeWidth])
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
  const { fill, kind, setFillEnabled, setKind, setStrokeEnabled, stroke } = useShapeEditor(engine);
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
        setKind(next);
      }
    },
    [kind, setKind]
  );
  const onFillToggle = useCallback((checked: boolean) => setFillEnabled(checked), [setFillEnabled]);
  const onStrokeToggle = useCallback((checked: boolean) => setStrokeEnabled(checked), [setStrokeEnabled]);
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
  const { fill, setFillColor, setStrokeColor, stroke } = useShapeEditor(engine);
  const sampleColor = useColorSampler(engine);
  const onFillChange = useCallback((hex: string) => setFillColor(hex, false), [setFillColor]);
  const onFillChangeEnd = useCallback((hex: string) => setFillColor(hex, true), [setFillColor]);
  const onStrokeChange = useCallback((hex: string) => setStrokeColor(hex, false), [setStrokeColor]);
  const onStrokeChangeEnd = useCallback((hex: string) => setStrokeColor(hex, true), [setStrokeColor]);
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
