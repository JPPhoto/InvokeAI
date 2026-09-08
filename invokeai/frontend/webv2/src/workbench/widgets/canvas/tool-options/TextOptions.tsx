import type { SelectValueChangeDetails } from '@chakra-ui/react';
import type { CanvasLayerSourceContract, CanvasTextFontRef, TextToolOptions } from '@workbench/canvas-engine/api';
import type { ToolFormProps } from '@workbench/widgets/canvas/tool-presentation/toolFormContracts';

import { Box, createListCollection, HStack, Spinner, Text } from '@chakra-ui/react';
import { fontsInfiniteQueryOptions, type FontAxis, type FontRecord } from '@features/fonts';
import { Button, IconButton, ToggleIconButton } from '@platform/ui/Button';
import { ColorPicker } from '@platform/ui/ColorPicker';
import { Select } from '@platform/ui/Select';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  MAX_TEXT_FONT_SIZE,
  MIN_TEXT_FONT_SIZE,
  TEXT_FONT_FAMILIES,
  TEXT_FONT_WEIGHTS,
  getDocumentLayer,
} from '@workbench/canvas-engine/api';
import { useActiveColorCommands, useActiveColorPair } from '@workbench/widgets/canvas/color-system/useActiveColors';
import { useTextEditSession, useTextOptions } from '@workbench/widgets/canvas/engineStoreHooks';
import {
  FormNumberField,
  FormSlider,
  useNumberCommit,
  useSliderGesture,
} from '@workbench/widgets/canvas/tool-presentation/FormControls';
import { EditTargetChip, PropertyControlRow } from '@workbench/widgets/canvas/tool-presentation/PropertyPrimitives';
import { useColorSampler } from '@workbench/widgets/canvas/useColorSampler';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { AlignCenterIcon, AlignLeftIcon, AlignRightIcon, RotateCcwIcon, SlidersHorizontalIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type TextSource = Extract<CanvasLayerSourceContract, { type: 'text' }>;
type TextAlign = TextToolOptions['align'];

interface SelectedText {
  id: string;
  name: string;
  source: TextSource;
}

const SELECT_POSITIONING = { placement: 'bottom-start', sameWidth: false } as const;
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
const EMPTY_FONT_VARIATIONS: Readonly<Record<string, number>> = {};
const EMPTY_FONT_RECORDS: readonly FontRecord[] = [];

type FontChoiceGroup = 'builtin' | 'custom';

interface FontChoice {
  family: string;
  font?: FontRecord;
  group: FontChoiceGroup;
  label: string;
  ref?: CanvasTextFontRef;
  value: string;
}

const sameFontRef = (left: CanvasTextFontRef | undefined, right: CanvasTextFontRef | undefined): boolean =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.id === right.id &&
    left.contentHash === right.contentHash &&
    left.family === right.family &&
    left.label === right.label);

const fontReferenceFromRecord = (font: FontRecord): CanvasTextFontRef => ({
  contentHash: font.contentHash,
  family: font.family,
  id: font.id,
  label: font.label,
});

const fontChoiceValue = (font: FontRecord | CanvasTextFontRef): string =>
  `custom:${font.id}:${font.contentHash}:${font.label}`;

const normalizeFontStyle = (style: string): NonNullable<TextSource['fontStyle']> =>
  style === 'italic' || style === 'oblique' ? style : 'normal';

/** Keeps v3 built-in sources free of optional defaults that force a v4 rewrite. */
export const canonicalizeSelectedTextSource = (source: TextSource): TextSource => {
  const next = { ...source };
  if (next.fontRef === undefined) {
    delete next.fontRef;
  }
  if (next.fontStyle === undefined || next.fontStyle === 'normal') {
    delete next.fontStyle;
  }
  if (!next.fontVariations || Object.keys(next.fontVariations).length === 0) {
    delete next.fontVariations;
  } else {
    next.fontVariations = { ...next.fontVariations };
  }
  return next;
};

const clampFontAxisValue = (value: number, axis: FontAxis): number =>
  Math.min(axis.maximum, Math.max(axis.minimum, Number.isFinite(value) ? value : axis.default));

/** Keeps variation maps aligned with the catalog's declared axes and exact coordinates. */
const fontVariationCoordinates = (
  font: FontRecord,
  coordinates: Readonly<Record<string, number>> = {}
): Record<string, number> =>
  Object.fromEntries(
    font.axes.map((axis) => [axis.tag, clampFontAxisValue(coordinates[axis.tag] ?? axis.default, axis)])
  );

const axisStep = (axis: FontAxis): number => {
  const span = axis.maximum - axis.minimum;
  if (span <= 2) {
    return 0.01;
  }
  if (span <= 200) {
    return 0.1;
  }
  return 1;
};

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
 * text layer, else the tool defaults — with color from the active foreground
 * when neither a session nor a selection owns one, so there is no second
 * global text color. Style edits update the defaults, then restyle the live
 * session (folded into its single commit) or commit one history entry on the
 * selected layer; color edits with nothing to own them edit the pair.
 */
const useTextEditor = (engine: ToolFormProps['engine']) => {
  const { t } = useTranslation();
  const commitPrepared = usePreparedCommit(engine);
  const options = useTextOptions(engine);
  const pair = useActiveColorPair();
  const colorCommands = useActiveColorCommands();
  const session = useTextEditSession(engine);
  const selected = useActiveProjectSelector(
    (project): SelectedText | null => {
      const { document } = project.canvas;
      const layer = document.selectedLayerId ? getDocumentLayer(document, document.selectedLayerId) : undefined;
      return layer && layer.type === 'raster' && layer.source.type === 'text'
        ? { id: layer.id, name: layer.name, source: layer.source }
        : null;
    },
    (a, b) => a?.id === b?.id && a?.name === b?.name && a?.source === b?.source
  );
  const styleSource = session ? session.source : (selected?.source ?? null);
  const align = styleSource?.align ?? options.align;
  const fontFamily = styleSource?.fontFamily ?? options.fontFamily;
  const fontSize = styleSource?.fontSize ?? options.fontSize;
  const fontWeight = styleSource?.fontWeight ?? options.fontWeight;
  const fontRef = styleSource ? styleSource.fontRef : options.fontRef;
  const fontStyle = styleSource ? (styleSource.fontStyle ?? 'normal') : (options.fontStyle ?? 'normal');
  const fontVariations = styleSource
    ? (styleSource.fontVariations ?? EMPTY_FONT_VARIATIONS)
    : (options.fontVariations ?? EMPTY_FONT_VARIATIONS);
  const lineHeight = styleSource?.lineHeight ?? options.lineHeight;
  const color = styleSource?.color ?? pair.foreground;
  const active = useMemo(
    () => ({ align, color, fontFamily, fontRef, fontSize, fontStyle, fontVariations, fontWeight, lineHeight }),
    [align, color, fontFamily, fontRef, fontSize, fontStyle, fontVariations, fontWeight, lineHeight]
  );
  const applyEdit = useCallback(
    (patch: Partial<TextSource>, commit: boolean) => {
      const { color: colorPatch, ...stylePatch } = patch;
      if (Object.keys(stylePatch).length > 0) {
        engine.interaction.set('textOptions', {
          align,
          fontFamily,
          fontRef,
          fontSize,
          fontStyle,
          fontVariations,
          fontWeight,
          lineHeight,
          ...stylePatch,
        });
      }
      if (session) {
        engine.layers.updateTextEditStyle(patch);
        return;
      }
      if (selected) {
        if (commit) {
          const after = canonicalizeSelectedTextSource({ ...selected.source, ...patch });
          commitPrepared(t('widgets.canvas.toolOptions.textEdit'), (model) =>
            model.prepare({ id: selected.id, source: after, type: 'patch-source' })
          );
        }
        return;
      }
      if (colorPatch !== undefined) {
        colorCommands.setPairColor('foreground', colorPatch);
      }
    },
    [
      align,
      colorCommands,
      commitPrepared,
      engine,
      fontFamily,
      fontRef,
      fontSize,
      fontStyle,
      fontVariations,
      fontWeight,
      lineHeight,
      selected,
      session,
      t,
    ]
  );
  // The chip names what applyEdit actually writes: the SESSION when one is
  // open (its layer's name, or the new-text placeholder in create mode), else
  // the selected text layer, else the defaults.
  const sessionLayerName = useActiveProjectSelector((project): string | null => {
    if (!session?.layerId) {
      return null;
    }
    return getDocumentLayer(project.canvas.document, session.layerId)?.name ?? null;
  });
  const targetName = session ? (sessionLayerName ?? t('widgets.properties.target.newText')) : (selected?.name ?? null);
  return { active, applyEdit, targetName };
};

const AxisControl = ({
  activeVariations,
  applyEdit,
  axis,
}: {
  activeVariations: Readonly<Record<string, number>>;
  applyEdit: (patch: Partial<TextSource>, commit: boolean) => void;
  axis: FontAxis;
}) => {
  const committed = clampFontAxisValue(activeVariations[axis.tag] ?? axis.default, axis);
  const step = axisStep(axis);
  const precision = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const setValue = useCallback(
    (value: number, commit: boolean) => {
      const next = clampFontAxisValue(value, axis);
      applyEdit({ fontVariations: { ...activeVariations, [axis.tag]: next } }, commit);
    },
    [activeVariations, applyEdit, axis]
  );
  const previewValue = useCallback((value: number) => setValue(value, false), [setValue]);
  const commitValue = useCallback((value: number) => setValue(value, true), [setValue]);
  const gesture = useSliderGesture(committed, commitValue, previewValue);
  const onNumber = useNumberCommit(commitValue);
  const displayedValue = gesture.value.toFixed(precision);
  const ariaLabel = `${axis.label} (${axis.tag})`;

  return (
    <PropertyControlRow label={ariaLabel}>
      <FormSlider
        aria-label={ariaLabel}
        max={axis.maximum}
        min={axis.minimum}
        step={step}
        value={gesture.value}
        onValueChange={gesture.onChange}
        onValueChangeEnd={gesture.onChangeEnd}
      />
      <FormNumberField
        aria-label={ariaLabel}
        max={axis.maximum}
        min={axis.minimum}
        step={step}
        value={displayedValue}
        onValueCommit={onNumber}
      />
    </PropertyControlRow>
  );
};

const variationMapsEqual = (
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
  axes: readonly FontAxis[]
): boolean => axes.every((axis) => left[axis.tag] === right[axis.tag]);

const FontAxisSettings = ({
  activeVariations,
  applyEdit,
  font,
}: {
  activeVariations: Readonly<Record<string, number>>;
  applyEdit: (patch: Partial<TextSource>, commit: boolean) => void;
  font?: FontRecord;
}) => {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const axes = useMemo(() => font?.axes.filter((axis) => axis.maximum > axis.minimum) ?? [], [font?.axes]);
  const visibleAxes = useMemo(() => axes.filter((axis) => showAdvanced || !axis.hidden), [axes, showAdvanced]);
  const hasHiddenAxes = axes.some((axis) => axis.hidden);
  const presetCollection = useMemo(
    () =>
      createListCollection<{ label: string; value: string }>({
        items: [
          { label: t('widgets.canvas.toolOptions.textFontDefaultPreset'), value: 'default' },
          ...(font?.instances ?? []).map((instance, index) => ({ label: instance.name, value: `instance:${index}` })),
        ],
      }),
    [font?.instances, t]
  );
  const presetValue = useMemo(() => {
    if (!font) {
      return ['default'];
    }
    const defaultCoordinates = fontVariationCoordinates(font);
    if (variationMapsEqual(activeVariations, defaultCoordinates, axes)) {
      return ['default'];
    }
    const instanceIndex = font.instances.findIndex((instance) =>
      variationMapsEqual(activeVariations, fontVariationCoordinates(font, instance.coordinates), axes)
    );
    return [instanceIndex >= 0 ? `instance:${instanceIndex}` : 'default'];
  }, [activeVariations, axes, font]);
  const onPreset = useCallback(
    ({ value }: SelectValueChangeDetails<{ label: string; value: string }>) => {
      if (!font) {
        return;
      }
      const selection = value[0];
      if (selection === 'default') {
        applyEdit({ fontVariations: fontVariationCoordinates(font) }, true);
        return;
      }
      const index = selection?.startsWith('instance:') ? Number(selection.slice('instance:'.length)) : -1;
      const instance = Number.isInteger(index) && index >= 0 ? font.instances[index] : undefined;
      if (instance) {
        applyEdit({ fontVariations: fontVariationCoordinates(font, instance.coordinates) }, true);
      }
    },
    [applyEdit, font]
  );
  const resetAxes = useCallback(() => {
    if (font) {
      applyEdit({ fontVariations: fontVariationCoordinates(font) }, true);
    }
  }, [applyEdit, font]);

  if (!font || axes.length === 0) {
    return null;
  }

  const advancedLabel = t(
    showAdvanced
      ? 'widgets.canvas.toolOptions.textFontHideAdvancedAxes'
      : 'widgets.canvas.toolOptions.textFontShowAdvancedAxes'
  );

  return (
    <Box borderColor="border.subtle" borderTopWidth="1px" mt="1" pt="1">
      <HStack justifyContent="space-between" minH="7">
        <Text color="fg.muted" fontSize="xs">
          {t('widgets.canvas.toolOptions.textFontAxes')}
        </Text>
        <HStack gap="1">
          <Button
            aria-label={t('widgets.canvas.toolOptions.textFontResetAxes')}
            size="2xs"
            variant="ghost"
            onClick={resetAxes}
          >
            <RotateCcwIcon />
          </Button>
          {hasHiddenAxes ? (
            <ToggleIconButton
              checked={showAdvanced}
              icon={SlidersHorizontalIcon}
              label={advancedLabel}
              onCheckedChange={setShowAdvanced}
            />
          ) : null}
        </HStack>
      </HStack>
      <PropertyControlRow label={t('widgets.canvas.toolOptions.textFontPreset')}>
        <Select
          aria-label={t('widgets.canvas.toolOptions.textFontPreset')}
          collection={presetCollection}
          gridColumn="2 / -1"
          positioning={SELECT_POSITIONING}
          size="xs"
          value={presetValue}
          valueText={presetCollection.items.find((item) => item.value === presetValue[0])?.label}
          w="full"
          onValueChange={onPreset}
        />
      </PropertyControlRow>
      {visibleAxes.map((axis) => (
        <AxisControl key={axis.tag} activeVariations={activeVariations} applyEdit={applyEdit} axis={axis} />
      ))}
    </Box>
  );
};

export const TextFontSettings = ({ engine }: ToolFormProps) => {
  const { t } = useTranslation();
  const { t: tFonts } = useTranslation('fonts');
  const { active, applyEdit, targetName } = useTextEditor(engine);
  const { data, fetchNextPage, hasNextPage, isError, isFetchNextPageError, isFetchingNextPage, isPending, refetch } =
    useInfiniteQuery(fontsInfiniteQueryOptions({ limit: 100, scope: 'all' }));
  const loadMoreFonts = useCallback(() => void fetchNextPage(), [fetchNextPage]);
  const retryFontCatalog = useCallback(() => {
    if (isFetchNextPageError) {
      void fetchNextPage();
      return;
    }
    void refetch();
  }, [fetchNextPage, isFetchNextPageError, refetch]);
  const fonts = useMemo(() => data?.pages.flatMap((page) => page.items) ?? EMPTY_FONT_RECORDS, [data?.pages]);
  const familyChoices = useMemo(() => {
    const builtins: FontChoice[] = TEXT_FONT_FAMILIES.map((font) => ({
      family: font.value,
      group: 'builtin',
      label: font.label,
      value: `builtin:${font.value}`,
    }));
    const custom = [...fonts]
      .sort((left, right) => left.family.localeCompare(right.family) || left.label.localeCompare(right.label))
      .map((font): FontChoice => ({
        family: font.family,
        font,
        group: 'custom',
        label: font.label,
        ref: fontReferenceFromRecord(font),
        value: fontChoiceValue(font),
      }));
    if (active.fontRef && !custom.some((choice) => sameFontRef(choice.ref, active.fontRef))) {
      custom.push({
        family: active.fontRef.family,
        group: 'custom',
        label: active.fontRef.label,
        ref: { ...active.fontRef },
        value: fontChoiceValue(active.fontRef),
      });
    }
    return [...builtins, ...custom];
  }, [active.fontRef, fonts]);
  const familyCollection = useMemo(() => createListCollection<FontChoice>({ items: familyChoices }), [familyChoices]);
  const groupBy = useCallback((item: FontChoice) => item.group, []);
  const renderGroupLabel = useCallback(
    (group: string) =>
      group === 'custom'
        ? t('widgets.canvas.toolOptions.textFontCustomGroup')
        : t('widgets.canvas.toolOptions.textFontBuiltinGroup'),
    [t]
  );
  const activeChoice = useMemo(
    () =>
      familyChoices.find((choice) =>
        choice.group === 'custom'
          ? sameFontRef(choice.ref, active.fontRef)
          : active.fontRef === undefined && choice.family === active.fontFamily
      ),
    [active.fontFamily, active.fontRef, familyChoices]
  );
  const familyValue = useMemo(
    () => [activeChoice?.value ?? active.fontFamily],
    [active.fontFamily, activeChoice?.value]
  );
  const familyLabel = activeChoice?.label ?? active.fontRef?.label ?? active.fontFamily;
  const activeFont = activeChoice?.font;
  const hasWeightAxis = activeFont?.axes.some((axis) => axis.tag === 'wght') ?? false;
  const hasStyleAxis = activeFont?.axes.some((axis) => axis.tag === 'ital' || axis.tag === 'slnt') ?? false;
  const onFamily = useCallback(
    ({ value }: SelectValueChangeDetails<FontChoice>) => {
      const choice = familyChoices.find((entry) => entry.value === value[0]);
      if (!choice) {
        return;
      }
      if (choice.group === 'builtin') {
        if (active.fontFamily !== choice.family || active.fontRef !== undefined) {
          applyEdit({ fontFamily: choice.family, fontRef: undefined, fontStyle: 'normal', fontVariations: {} }, true);
        }
        return;
      }
      if (!choice.font || !choice.ref) {
        return;
      }
      if (active.fontFamily === choice.family && sameFontRef(active.fontRef, choice.ref)) {
        return;
      }
      applyEdit(
        {
          fontFamily: choice.family,
          fontRef: choice.ref,
          fontStyle: normalizeFontStyle(choice.font.style),
          fontVariations: fontVariationCoordinates(choice.font),
          fontWeight:
            Number.isFinite(choice.font.weight) && choice.font.weight > 0 ? choice.font.weight : active.fontWeight,
        },
        true
      );
    },
    [active.fontFamily, active.fontRef, active.fontWeight, applyEdit, familyChoices]
  );
  const styleCollection = useMemo(
    () =>
      createListCollection<{ label: string; value: NonNullable<TextSource['fontStyle']> }>({
        items: [
          { label: t('widgets.canvas.toolOptions.textFontStyleNormal'), value: 'normal' },
          { label: t('widgets.canvas.toolOptions.textFontStyleItalic'), value: 'italic' },
          { label: t('widgets.canvas.toolOptions.textFontStyleOblique'), value: 'oblique' },
        ],
      }),
    [t]
  );
  const onStyle = useCallback(
    ({ value }: SelectValueChangeDetails<{ label: string; value: NonNullable<TextSource['fontStyle']> }>) => {
      const next = value[0];
      if ((next === 'normal' || next === 'italic' || next === 'oblique') && next !== active.fontStyle) {
        applyEdit({ fontStyle: next }, true);
      }
    },
    [active.fontStyle, applyEdit]
  );
  const weightValues = useMemo(
    () =>
      [...new Set([...TEXT_FONT_WEIGHTS, active.fontWeight].filter((weight) => Number.isFinite(weight)))].sort(
        (a, b) => a - b
      ),
    [active.fontWeight]
  );
  const weightCollection = useMemo(
    () =>
      createListCollection<{ label: string; value: string }>({
        items: weightValues.map((weight) => ({ label: String(weight), value: String(weight) })),
      }),
    [weightValues]
  );
  const weightValue = useMemo(() => [String(active.fontWeight)], [active.fontWeight]);
  const styleValue = useMemo(() => [active.fontStyle], [active.fontStyle]);
  const onWeight = useCallback(
    ({ value }: SelectValueChangeDetails<{ label: string; value: string }>) => {
      const next = value[0] ? Number(value[0]) : undefined;
      if (next !== undefined && Number.isFinite(next) && next !== active.fontWeight) {
        applyEdit({ fontWeight: next }, true);
      }
    },
    [active.fontWeight, applyEdit]
  );
  // Ticks preview through the defaults/session; ONE document commit lands on release.
  const previewSize = useCallback(
    (value: number) =>
      applyEdit({ fontSize: Math.min(MAX_TEXT_FONT_SIZE, Math.max(MIN_TEXT_FONT_SIZE, Math.round(value))) }, false),
    [applyEdit]
  );
  const setSize = useCallback(
    (value: number) =>
      applyEdit({ fontSize: Math.min(MAX_TEXT_FONT_SIZE, Math.max(MIN_TEXT_FONT_SIZE, Math.round(value))) }, true),
    [applyEdit]
  );
  const sizeGesture = useSliderGesture(Math.round(active.fontSize), setSize, previewSize);
  const onSize = useNumberCommit(setSize);
  const previewLineHeight = useCallback(
    (value: number) => applyEdit({ lineHeight: Math.max(0.5, Math.round(value * 10) / 10) }, false),
    [applyEdit]
  );
  const setLineHeight = useCallback(
    (value: number) => applyEdit({ lineHeight: Math.max(0.5, Math.round(value * 10) / 10) }, true),
    [applyEdit]
  );
  const lineHeightGesture = useSliderGesture(active.lineHeight, setLineHeight, previewLineHeight);
  const onLineHeight = useNumberCommit(setLineHeight);
  return (
    <>
      <EditTargetChip layerName={targetName} />
      <PropertyControlRow label={t('widgets.properties.rows.family')}>
        <HStack gap="1" gridColumn="2 / -1" minW="0" w="full">
          <Select
            aria-label={t('widgets.canvas.toolOptions.textFont')}
            collection={familyCollection}
            flex="1"
            groupBy={groupBy}
            itemsMaxH="20rem"
            minW="0"
            positioning={SELECT_POSITIONING}
            renderGroupLabel={renderGroupLabel}
            size="xs"
            value={familyValue}
            valueText={familyLabel}
            onValueChange={onFamily}
          />
          {isPending ? (
            <HStack aria-live="polite" color="fg.muted" flexShrink="0" gap="1" role="status">
              <Spinner size="xs" />
              <Text fontSize="2xs">{t('common.loading')}</Text>
            </HStack>
          ) : isError ? (
            <HStack aria-live="polite" color="fg.error" flexShrink="0" gap="1" role="alert">
              <Text fontSize="2xs">{tFonts('fonts.couldNotLoad')}</Text>
              <Button
                aria-label={t('common.retry')}
                disabled={isFetchingNextPage}
                size="2xs"
                variant="ghost"
                onClick={retryFontCatalog}
              >
                {t('common.retry')}
              </Button>
            </HStack>
          ) : null}
        </HStack>
      </PropertyControlRow>
      {hasNextPage ? (
        <HStack justify="flex-end" minH="7">
          <Button
            aria-label={tFonts('fonts.loadMore', { defaultValue: 'Load more fonts' })}
            disabled={isFetchingNextPage}
            size="2xs"
            variant="ghost"
            onClick={loadMoreFonts}
          >
            {isFetchingNextPage
              ? tFonts('fonts.loadingMore', { defaultValue: 'Loading more fonts…' })
              : tFonts('fonts.loadMore', { defaultValue: 'Load more fonts' })}
          </Button>
        </HStack>
      ) : null}
      <PropertyControlRow label={t('widgets.canvas.toolOptions.textFontStyle')}>
        <Select
          aria-label={t('widgets.canvas.toolOptions.textFontStyle')}
          collection={styleCollection}
          disabled={hasStyleAxis}
          gridColumn="2 / -1"
          positioning={SELECT_POSITIONING}
          size="xs"
          value={styleValue}
          valueText={styleCollection.items.find((item) => item.value === active.fontStyle)?.label}
          w="full"
          onValueChange={onStyle}
        />
      </PropertyControlRow>
      <PropertyControlRow label={t('widgets.properties.rows.size')}>
        <FormSlider
          aria-label={t('widgets.canvas.toolOptions.textSize')}
          max={MAX_TEXT_FONT_SIZE}
          min={MIN_TEXT_FONT_SIZE}
          value={sizeGesture.value}
          onValueChange={sizeGesture.onChange}
          onValueChangeEnd={sizeGesture.onChangeEnd}
        />
        <FormNumberField
          aria-label={t('widgets.canvas.toolOptions.textSize')}
          max={MAX_TEXT_FONT_SIZE}
          min={MIN_TEXT_FONT_SIZE}
          suffix="px"
          value={String(Math.round(active.fontSize))}
          onValueCommit={onSize}
        />
      </PropertyControlRow>
      <PropertyControlRow label={t('widgets.properties.rows.weight')}>
        <Select
          aria-label={t('widgets.canvas.toolOptions.textWeight')}
          collection={weightCollection}
          disabled={hasWeightAxis}
          flexShrink={0}
          positioning={SELECT_POSITIONING}
          size="xs"
          triggerProps={WEIGHT_TRIGGER_PROPS}
          value={weightValue}
          valueText={String(active.fontWeight)}
          w="4.5rem"
          onValueChange={onWeight}
        />
      </PropertyControlRow>
      <PropertyControlRow label={t('widgets.properties.rows.lineHeight')}>
        <FormSlider
          aria-label={t('widgets.canvas.toolOptions.textLineHeight')}
          max={4}
          min={0.5}
          step={0.1}
          value={lineHeightGesture.value}
          onValueChange={lineHeightGesture.onChange}
          onValueChangeEnd={lineHeightGesture.onChangeEnd}
        />
        <FormNumberField
          aria-label={t('widgets.canvas.toolOptions.textLineHeight')}
          max={4}
          min={0.5}
          step={0.1}
          value={active.lineHeight.toFixed(1)}
          onValueCommit={onLineHeight}
        />
      </PropertyControlRow>
      <FontAxisSettings activeVariations={active.fontVariations} applyEdit={applyEdit} font={activeChoice?.font} />
    </>
  );
};

export const TextParagraphSettings = ({ engine }: ToolFormProps) => {
  const { t } = useTranslation();
  const { active, applyEdit } = useTextEditor(engine);
  const onAlign = useCallback((next: TextAlign) => applyEdit({ align: next }, true), [applyEdit]);
  return (
    <PropertyControlRow label={t('widgets.properties.rows.align')}>
      <HStack gap="0.5">
        {ALIGN_VALUES.map((value) => (
          <AlignButton key={value} active={active.align === value} value={value} onSelect={onAlign} />
        ))}
      </HStack>
    </PropertyControlRow>
  );
};

export const TextColorSettings = ({ engine }: ToolFormProps) => {
  const { t } = useTranslation();
  const { active, applyEdit } = useTextEditor(engine);
  const sampleColor = useColorSampler(engine);
  const onChange = useCallback((hex: string) => applyEdit({ color: hex }, false), [applyEdit]);
  const onChangeEnd = useCallback((hex: string) => applyEdit({ color: hex }, true), [applyEdit]);
  return (
    <PropertyControlRow label={t('widgets.properties.rows.color')}>
      <ColorPicker
        aria-label={t('widgets.canvas.toolOptions.textColor')}
        value={active.color}
        onSampleColor={sampleColor}
        onValueChange={onChange}
        onValueChangeEnd={onChangeEnd}
      />
    </PropertyControlRow>
  );
};
