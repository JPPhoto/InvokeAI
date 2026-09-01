import type { SelectValueChangeDetails } from '@chakra-ui/react';
import type { CanvasLayerSourceContract, GradientStop, GradientToolOptions } from '@workbench/canvas-engine/api';
import type {
  ToolbarRegionProps,
  ToolPresentationAdapter,
} from '@workbench/widgets/canvas/tool-presentation/toolbarContracts';

import { createListCollection } from '@chakra-ui/react';
import { ToggleIconButton } from '@platform/ui/Button';
import { ColorPicker } from '@platform/ui/ColorPicker';
import { Select } from '@platform/ui/Select';
import { getDocumentLayer } from '@workbench/canvas-engine/api';
import { useActiveColorPair } from '@workbench/widgets/canvas/color-system/useActiveColors';
import { useGradientOptions } from '@workbench/widgets/canvas/engineStoreHooks';
import { ToolbarNumberField, useNumberCommit } from '@workbench/widgets/canvas/tool-presentation/ToolbarPrimitives';
import { useColorSampler } from '@workbench/widgets/canvas/useColorSampler';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { PaletteIcon } from 'lucide-react';
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
 * selected gradient layer, else the tool defaults — where the built-in FG→BG
 * preset shows the live pair (resolved for real at gesture start) and editing
 * a stop switches to explicit custom stops, independent of later pair edits.
 * Edits commit to a selected gradient layer (colors once on release).
 */
const useGradientEditor = (engine: ToolbarRegionProps['engine']) => {
  const { t } = useTranslation();
  const commitPrepared = usePreparedCommit(engine);
  const options = useGradientOptions(engine);
  const pair = useActiveColorPair();
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
  const pairStops = useMemo<GradientStop[]>(
    () => [
      { color: `${pair.foreground}ff`, offset: 0 },
      { color: `${pair.background}ff`, offset: 1 },
    ],
    [pair.background, pair.foreground]
  );
  const stops = selected ? selected.source.stops : options.preset === 'pair' ? pairStops : options.stops;

  const apply = useCallback(
    (next: { angle: number; kind: GradientKind; stops: GradientStop[] }, commit: boolean) => {
      engine.interaction.set('gradientOptions', { ...options, angle: next.angle, kind: next.kind });
      if (selected && commit) {
        const after: GradientSource = { ...selected.source, ...next };
        commitPrepared(t('widgets.canvas.toolOptions.gradientEdit'), (model) =>
          model.prepare({ id: selected.id, source: after, type: 'patch-source' })
        );
      }
    },
    [commitPrepared, engine, options, selected, t]
  );
  const setCustomStops = useCallback(
    (nextStops: GradientStop[]) => {
      engine.interaction.set('gradientOptions', { ...options, preset: 'custom', stops: nextStops });
    },
    [engine, options]
  );
  const setPreset = useCallback(
    (preset: 'pair' | 'custom') => {
      // Leaving the preset keeps what the chips currently show as the custom set.
      engine.interaction.set('gradientOptions', {
        ...options,
        preset,
        stops:
          preset === 'custom' && options.preset === 'pair' ? pairStops.map((stop) => ({ ...stop })) : options.stops,
      });
    },
    [engine, options, pairStops]
  );
  return { angle, apply, kind, preset: selected ? null : options.preset, setCustomStops, setPreset, stops };
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
  const { angle, apply, kind, preset, setCustomStops, setPreset, stops } = useGradientEditor(engine);
  const sampleColor = useColorSampler(engine);
  const start = stops[0] ?? { color: '#000000ff', offset: 0 };
  const end = stops[stops.length - 1] ?? { color: '#ffffffff', offset: 1 };
  const setStop = useCallback(
    (index: number, color: string, commit: boolean) => {
      const nextStops = stops.map((stop, i) => (i === index ? { ...stop, color } : stop));
      if (preset === null) {
        // A selected gradient: explicit document stops, one entry on release.
        apply({ angle, kind, stops: nextStops }, commit);
        return;
      }
      // No selection: stop edits make the custom set explicit.
      setCustomStops(nextStops);
    },
    [angle, apply, kind, preset, setCustomStops, stops]
  );
  const onPresetToggle = useCallback((checked: boolean) => setPreset(checked ? 'pair' : 'custom'), [setPreset]);
  const last = stops.length - 1;
  const onStart = useCallback((color: string) => setStop(0, color, false), [setStop]);
  const onStartEnd = useCallback((color: string) => setStop(0, color, true), [setStop]);
  const onEnd = useCallback((color: string) => setStop(last, color, false), [last, setStop]);
  const onEndEnd = useCallback((color: string) => setStop(last, color, true), [last, setStop]);
  return (
    <>
      {/* Disabled, never removed, when a selected gradient owns the stops: the row keeps its geometry. */}
      <ToggleIconButton
        checked={preset === 'pair'}
        disabled={preset === null}
        icon={PaletteIcon}
        label={t('widgets.canvas.toolOptions.gradientPairPreset')}
        onCheckedChange={onPresetToggle}
      />
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
  rowLabels: {
    color: 'widgets.canvas.toolOptions.gradientStops',
    geometry: 'widgets.canvas.toolOptions.gradientAngle',
    modes: 'widgets.canvas.toolOptions.gradientKind',
  },
  color: GradientStops,
  geometry: GradientAngle,
  id: 'gradient',
  modes: GradientKindSelect,
  paintsLeaf: true,
};
