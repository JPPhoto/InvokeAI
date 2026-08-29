import type { SelectValueChangeDetails } from '@chakra-ui/react';
import type { CanvasLayerSourceContract, GradientStop, GradientToolOptions } from '@workbench/canvas-engine/api';
import type {
  ToolbarRegionProps,
  ToolPresentationAdapter,
} from '@workbench/widgets/canvas/context-toolbar/toolbarContracts';

import { createListCollection } from '@chakra-ui/react';
import { ColorPicker, Select } from '@platform/ui';
import { getDocumentLayer } from '@workbench/canvas-engine/api';
import { ToolbarNumberField, useNumberCommit } from '@workbench/widgets/canvas/context-toolbar/ToolbarPrimitives';
import { useGradientOptions } from '@workbench/widgets/canvas/engineStoreHooks';
import { useColorSampler } from '@workbench/widgets/canvas/useColorSampler';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { PaintBucketIcon } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

type GradientSource = Extract<CanvasLayerSourceContract, { type: 'gradient' }>;
type GradientKind = GradientToolOptions['kind'];

interface SelectedGradient {
  id: string;
  source: GradientSource;
}

const SELECT_POSITIONING = { placement: 'bottom-start', sameWidth: false } as const;
const SELECT_TRIGGER_PROPS = { minW: '6rem', w: '6rem' } as const;

/**
 * Kind, angle and a minimal two-stop editor. Displayed values follow the
 * selected gradient layer, else the tool defaults; edits set the defaults AND
 * commit to a selected gradient layer (colors once on release).
 */
const useGradientEditor = (engine: ToolbarRegionProps['engine']) => {
  const { t } = useTranslation();
  const commitPrepared = usePreparedCommit(engine);
  const options = useGradientOptions(engine);
  const selected = useActiveProjectSelector(
    (project): SelectedGradient | null => {
      const { document } = project.canvas;
      const layer = document.selectedLayerId ? getDocumentLayer(document, document.selectedLayerId) : undefined;
      return layer && layer.type === 'raster' && layer.source.type === 'gradient'
        ? { id: layer.id, source: layer.source }
        : null;
    },
    (a, b) => a?.id === b?.id && a?.source === b?.source
  );
  const kind: GradientKind = selected ? selected.source.kind : options.kind;
  const angle = selected ? selected.source.angle : options.angle;
  const stops = selected ? selected.source.stops : options.stops;

  const apply = useCallback(
    (next: { angle: number; kind: GradientKind; stops: GradientStop[] }, commit: boolean) => {
      engine.interaction.set('gradientOptions', next);
      if (selected && commit) {
        const after: GradientSource = { ...selected.source, ...next };
        commitPrepared(t('widgets.canvas.toolOptions.gradientEdit'), (model) =>
          model.prepare({ id: selected.id, source: after, type: 'patch-source' })
        );
      }
    },
    [commitPrepared, engine, selected, t]
  );
  return { angle, apply, kind, stops };
};

const GradientAngle = ({ engine }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const { angle, apply, kind, stops } = useGradientEditor(engine);
  const onCommit = useNumberCommit(
    useCallback(
      (value: number) => apply({ angle: Math.round(value), kind, stops: [...stops] }, true),
      [apply, kind, stops]
    )
  );
  return (
    <ToolbarNumberField
      aria-label={t('widgets.canvas.toolOptions.gradientAngle')}
      disabled={kind === 'radial'}
      max={360}
      min={-360}
      suffix="°"
      value={String(Math.round(angle))}
      onValueCommit={onCommit}
    />
  );
};

const GradientKindSelect = ({ engine }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const { angle, apply, kind, stops } = useGradientEditor(engine);
  const collection = useMemo(
    () =>
      createListCollection<{ label: string; value: GradientKind }>({
        items: [
          { label: t('widgets.canvas.toolOptions.gradientLinear'), value: 'linear' },
          { label: t('widgets.canvas.toolOptions.gradientRadial'), value: 'radial' },
        ],
      }),
    [t]
  );
  const value = useMemo(() => [kind], [kind]);
  const onChange = useCallback(
    ({ value: next }: SelectValueChangeDetails<{ label: string; value: GradientKind }>) => {
      const kindNext = next[0] as GradientKind | undefined;
      if (kindNext && kindNext !== kind) {
        apply({ angle, kind: kindNext, stops: [...stops] }, true);
      }
    },
    [angle, apply, kind, stops]
  );
  return (
    <Select
      aria-label={t('widgets.canvas.toolOptions.gradientKind')}
      collection={collection}
      positioning={SELECT_POSITIONING}
      size="xs"
      flexShrink={0}
      triggerProps={SELECT_TRIGGER_PROPS}
      w="6rem"
      value={value}
      valueText={t(
        kind === 'radial' ? 'widgets.canvas.toolOptions.gradientRadial' : 'widgets.canvas.toolOptions.gradientLinear'
      )}
      onValueChange={onChange}
    />
  );
};

const GradientStops = ({ engine }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const { angle, apply, kind, stops } = useGradientEditor(engine);
  const sampleColor = useColorSampler(engine);
  const start = stops[0] ?? { color: '#000000ff', offset: 0 };
  const end = stops[stops.length - 1] ?? { color: '#ffffffff', offset: 1 };
  const setStop = useCallback(
    (index: number, color: string, commit: boolean) =>
      apply({ angle, kind, stops: stops.map((stop, i) => (i === index ? { ...stop, color } : stop)) }, commit),
    [angle, apply, kind, stops]
  );
  const last = stops.length - 1;
  const onStart = useCallback((color: string) => setStop(0, color, false), [setStop]);
  const onStartEnd = useCallback((color: string) => setStop(0, color, true), [setStop]);
  const onEnd = useCallback((color: string) => setStop(last, color, false), [last, setStop]);
  const onEndEnd = useCallback((color: string) => setStop(last, color, true), [last, setStop]);
  return (
    <>
      <ColorPicker
        aria-label={t('widgets.canvas.toolOptions.gradientStart')}
        value={start.color}
        withAlpha
        onSampleColor={sampleColor}
        onValueChange={onStart}
        onValueChangeEnd={onStartEnd}
      />
      <ColorPicker
        aria-label={t('widgets.canvas.toolOptions.gradientEnd')}
        value={end.color}
        withAlpha
        onSampleColor={sampleColor}
        onValueChange={onEnd}
        onValueChangeEnd={onEndEnd}
      />
    </>
  );
};

export const gradientAdapter: ToolPresentationAdapter = {
  color: GradientStops,
  geometry: GradientAngle,
  icon: PaintBucketIcon,
  id: 'gradient',
  modes: { component: GradientKindSelect, width: 96 },
  paintsLeaf: true,
  primary: 'modes',
};
