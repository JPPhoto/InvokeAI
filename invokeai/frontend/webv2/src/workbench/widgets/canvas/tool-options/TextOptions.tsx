import type { SelectValueChangeDetails } from '@chakra-ui/react';
import type { CanvasLayerSourceContract, TextToolOptions } from '@workbench/canvas-engine/api';
import type {
  ToolbarRegionProps,
  ToolPresentationAdapter,
} from '@workbench/widgets/canvas/tool-presentation/toolbarContracts';

import { createListCollection, HStack } from '@chakra-ui/react';
import { ColorPicker, IconButton, Select } from '@platform/ui';
import {
  MAX_TEXT_FONT_SIZE,
  MIN_TEXT_FONT_SIZE,
  TEXT_FONT_FAMILIES,
  TEXT_FONT_WEIGHTS,
  getDocumentLayer,
} from '@workbench/canvas-engine/api';
import { useTextEditSession, useTextOptions } from '@workbench/widgets/canvas/engineStoreHooks';
import { ToolbarNumberField, useNumberCommit } from '@workbench/widgets/canvas/tool-presentation/ToolbarPrimitives';
import { useColorSampler } from '@workbench/widgets/canvas/useColorSampler';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { AlignCenterIcon, AlignLeftIcon, AlignRightIcon } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

type TextSource = Extract<CanvasLayerSourceContract, { type: 'text' }>;
type TextAlign = TextToolOptions['align'];

interface SelectedText {
  id: string;
  source: TextSource;
}

const SELECT_POSITIONING = { placement: 'bottom-start', sameWidth: false } as const;
const FAMILY_TRIGGER_PROPS = { minW: '7rem', w: '7rem' } as const;
const WEIGHT_TRIGGER_PROPS = { minW: '4.5rem', w: '4.5rem' } as const;

const ALIGN_ICONS: Record<TextAlign, typeof AlignLeftIcon> = {
  center: AlignCenterIcon,
  left: AlignLeftIcon,
  right: AlignRightIcon,
};

const ALIGN_LABEL_KEYS: Record<TextAlign, string> = {
  center: 'widgets.canvas.toolOptions.textAlignCenter',
  left: 'widgets.canvas.toolOptions.textAlignLeft',
  right: 'widgets.canvas.toolOptions.textAlignRight',
};

const ALIGN_VALUES: readonly TextAlign[] = ['left', 'center', 'right'];

const AlignButton = ({
  active,
  onSelect,
  value,
}: {
  active: boolean;
  onSelect: (value: TextAlign) => void;
  value: TextAlign;
}) => {
  const { t } = useTranslation();
  const Icon = ALIGN_ICONS[value];
  const onClick = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <IconButton
      aria-label={t(ALIGN_LABEL_KEYS[value])}
      aria-pressed={active}
      size="xs"
      variant={active ? 'solid' : 'ghost'}
      onClick={onClick}
    >
      <Icon />
    </IconButton>
  );
};

/**
 * Displayed values: an open editing session's live source, else the selected
 * text layer, else the tool defaults. Edits always update the defaults, then
 * restyle the live session (folded into its single commit) or commit one
 * history entry on the selected layer; colors commit on release.
 */
const useTextEditor = (engine: ToolbarRegionProps['engine']) => {
  const { t } = useTranslation();
  const commitPrepared = usePreparedCommit(engine);
  const options = useTextOptions(engine);
  const session = useTextEditSession(engine);
  const selected = useActiveProjectSelector(
    (project): SelectedText | null => {
      const { document } = project.canvas;
      const layer = document.selectedLayerId ? getDocumentLayer(document, document.selectedLayerId) : undefined;
      return layer && layer.type === 'raster' && layer.source.type === 'text'
        ? { id: layer.id, source: layer.source }
        : null;
    },
    (a, b) => a?.id === b?.id && a?.source === b?.source
  );
  const active: TextToolOptions = session ? session.source : (selected?.source ?? options);
  const { align, color, fontFamily, fontSize, fontWeight, lineHeight } = active;
  const applyEdit = useCallback(
    (patch: Partial<TextToolOptions>, commit: boolean) => {
      engine.interaction.set('textOptions', { align, color, fontFamily, fontSize, fontWeight, lineHeight, ...patch });
      if (session) {
        engine.layers.updateTextEditStyle(patch);
        return;
      }
      if (selected && commit) {
        const after: TextSource = { ...selected.source, ...patch };
        commitPrepared(t('widgets.canvas.toolOptions.textEdit'), (model) =>
          model.prepare({ id: selected.id, source: after, type: 'patch-source' })
        );
      }
    },
    [align, color, commitPrepared, engine, fontFamily, fontSize, fontWeight, lineHeight, selected, session, t]
  );
  return { active, applyEdit };
};

const TextFamily = ({ engine }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const { active, applyEdit } = useTextEditor(engine);
  const familyCollection = useMemo(
    () => createListCollection<{ label: string; value: string }>({ items: [...TEXT_FONT_FAMILIES] }),
    []
  );
  const familyValue = useMemo(() => [active.fontFamily], [active.fontFamily]);
  const familyLabel = useMemo(
    () => TEXT_FONT_FAMILIES.find((entry) => entry.value === active.fontFamily)?.label ?? active.fontFamily,
    [active.fontFamily]
  );
  const onFamily = useCallback(
    ({ value }: SelectValueChangeDetails<{ label: string; value: string }>) => {
      const next = value[0];
      if (next && next !== active.fontFamily) {
        applyEdit({ fontFamily: next }, true);
      }
    },
    [active.fontFamily, applyEdit]
  );
  return (
    <Select
      aria-label={t('widgets.canvas.toolOptions.textFont')}
      collection={familyCollection}
      positioning={SELECT_POSITIONING}
      size="xs"
      flexShrink={0}
      triggerProps={FAMILY_TRIGGER_PROPS}
      w="7rem"
      value={familyValue}
      valueText={familyLabel}
      onValueChange={onFamily}
    />
  );
};

const TextStyle = ({ engine }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const { active, applyEdit } = useTextEditor(engine);
  const weightCollection = useMemo(
    () =>
      createListCollection<{ label: string; value: string }>({
        items: TEXT_FONT_WEIGHTS.map((weight) => ({ label: String(weight), value: String(weight) })),
      }),
    []
  );
  const weightValue = useMemo(() => [String(active.fontWeight)], [active.fontWeight]);
  const onWeight = useCallback(
    ({ value }: SelectValueChangeDetails<{ label: string; value: string }>) => {
      const next = value[0] ? Number(value[0]) : undefined;
      if (next && next !== active.fontWeight) {
        applyEdit({ fontWeight: next }, true);
      }
    },
    [active.fontWeight, applyEdit]
  );
  const onSize = useNumberCommit(
    useCallback(
      (value: number) =>
        applyEdit({ fontSize: Math.min(MAX_TEXT_FONT_SIZE, Math.max(MIN_TEXT_FONT_SIZE, Math.round(value))) }, true),
      [applyEdit]
    )
  );
  const onLineHeight = useNumberCommit(
    useCallback(
      (value: number) => applyEdit({ lineHeight: Math.max(0.5, Math.round(value * 10) / 10) }, true),
      [applyEdit]
    )
  );
  const onAlign = useCallback((next: TextAlign) => applyEdit({ align: next }, true), [applyEdit]);
  return (
    <>
      <ToolbarNumberField
        aria-label={t('widgets.canvas.toolOptions.textSize')}
        max={MAX_TEXT_FONT_SIZE}
        min={MIN_TEXT_FONT_SIZE}
        suffix="px"
        value={String(Math.round(active.fontSize))}
        onValueCommit={onSize}
      />
      <Select
        aria-label={t('widgets.canvas.toolOptions.textWeight')}
        collection={weightCollection}
        positioning={SELECT_POSITIONING}
        size="xs"
        flexShrink={0}
        triggerProps={WEIGHT_TRIGGER_PROPS}
        w="4.5rem"
        value={weightValue}
        valueText={String(active.fontWeight)}
        onValueChange={onWeight}
      />
      <ToolbarNumberField
        aria-label={t('widgets.canvas.toolOptions.textLineHeight')}
        max={4}
        min={0.5}
        step={0.1}
        value={active.lineHeight.toFixed(1)}
        onValueCommit={onLineHeight}
      />
      <HStack gap="0.5">
        {ALIGN_VALUES.map((value) => (
          <AlignButton key={value} active={active.align === value} value={value} onSelect={onAlign} />
        ))}
      </HStack>
    </>
  );
};

const TextColor = ({ engine }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const { active, applyEdit } = useTextEditor(engine);
  const sampleColor = useColorSampler(engine);
  const onChange = useCallback((hex: string) => applyEdit({ color: hex }, false), [applyEdit]);
  const onChangeEnd = useCallback((hex: string) => applyEdit({ color: hex }, true), [applyEdit]);
  return (
    <ColorPicker
      aria-label={t('widgets.canvas.toolOptions.textColor')}
      value={active.color}
      onSampleColor={sampleColor}
      onValueChange={onChange}
      onValueChangeEnd={onChangeEnd}
    />
  );
};

export const textAdapter: ToolPresentationAdapter = {
  rowLabels: {
    color: 'widgets.canvas.toolOptions.textColor',
    geometry: 'widgets.canvas.toolOptions.textFont',
    modes: 'widgets.canvas.toolOptions.textStyle',
  },
  color: TextColor,
  geometry: TextFamily,
  id: 'text',
  modes: TextStyle,
  paintsLeaf: true,
};
