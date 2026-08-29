import type { AspectRatioId } from '@features/generation/contracts';
import type {
  ToolbarRegionProps,
  ToolPresentationAdapter,
} from '@workbench/widgets/canvas/context-toolbar/toolbarContracts';

import { AspectRatioLockButton, AspectRatioSelect } from '@features/generation/components';
import { ASPECT_RATIO_MAP, deriveAspectRatioId } from '@features/generation/settings';
import { constrainBboxToRatio } from '@workbench/canvas-engine/api';
import { TOOLBAR_GAP_PX, TOOLBAR_NUMBER_FIELD_WIDTH_PX } from '@workbench/widgets/canvas/context-toolbar/toolbarLayout';
import { ToolbarNumberField, useNumberCommit } from '@workbench/widgets/canvas/context-toolbar/ToolbarPrimitives';
import { FrameIcon } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useBboxEditor } from './useBboxEditor';

const ASPECT_TRIGGER_PROPS = { minW: '7.5rem' } as const;

/** X / Y share the Move and Transform slots. Every edit is one undoable frame commit. */
const FramePosition = ({ engine }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const { bbox, setX, setY } = useBboxEditor(engine);
  const onX = useNumberCommit(setX);
  const onY = useNumberCommit(setY);
  return (
    <>
      <ToolbarNumberField
        aria-label={t('widgets.canvas.toolOptions.positionX')}
        label={t('widgets.canvas.toolOptions.positionX')}
        value={String(bbox.x)}
        onValueCommit={onX}
      />
      <ToolbarNumberField
        aria-label={t('widgets.canvas.toolOptions.positionY')}
        label={t('widgets.canvas.toolOptions.positionY')}
        value={String(bbox.y)}
        onValueCommit={onY}
      />
    </>
  );
};

/**
 * Frame size, aspect preset and lock; the preset controls are the generate
 * widget's, so both surfaces offer the same presets (`canvasDimsSync` keeps
 * them aligned). The lock is an engine setting; choosing a preset also
 * reshapes the frame in place as one undoable commit.
 */
const FrameSize = ({ engine }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const { bbox, commitBbox, grid, options, setHeight, setWidth } = useBboxEditor(engine);
  const onWidth = useNumberCommit(setWidth);
  const onHeight = useNumberCommit(setHeight);
  const bboxRatio = bbox.height > 0 ? bbox.width / bbox.height : 1;
  // Derived from the live frame so a lock captured from a hand-drawn bbox reports the preset it matches.
  const selectedId: AspectRatioId = options.aspectLocked ? deriveAspectRatioId(bbox.width, bbox.height) : 'Free';

  const onAspectPresetChange = useCallback(
    (id: AspectRatioId) => {
      if (id === 'Free') {
        engine.interaction.set('bboxOptions', { ...options, aspectLocked: false });
        return;
      }
      const ratio = ASPECT_RATIO_MAP[id].ratio;
      engine.interaction.set('bboxOptions', { aspectLocked: true, aspectRatio: ratio });
      commitBbox(constrainBboxToRatio(bbox, ratio, grid));
    },
    [bbox, commitBbox, engine, grid, options]
  );

  const onLockToggle = useCallback(() => {
    const checked = !options.aspectLocked;
    // Locking a frame that matches no preset captures its current ratio.
    const aspectRatio =
      checked && bbox.height > 0 && deriveAspectRatioId(bbox.width, bbox.height) === 'Free'
        ? bboxRatio
        : options.aspectRatio > 0
          ? options.aspectRatio
          : 1;
    engine.interaction.set('bboxOptions', { aspectLocked: checked, aspectRatio });
  }, [bbox, bboxRatio, engine, options.aspectLocked, options.aspectRatio]);

  return (
    <>
      <ToolbarNumberField
        aria-label={t('widgets.canvas.toolOptions.frameWidth')}
        label={t('widgets.canvas.toolOptions.frameWidth')}
        min={1}
        value={String(bbox.width)}
        onValueCommit={onWidth}
      />
      <ToolbarNumberField
        aria-label={t('widgets.canvas.toolOptions.frameHeight')}
        label={t('widgets.canvas.toolOptions.frameHeight')}
        min={1}
        value={String(bbox.height)}
        onValueCommit={onHeight}
      />
      <AspectRatioSelect
        fallbackRatio={bboxRatio}
        triggerProps={ASPECT_TRIGGER_PROPS}
        value={selectedId}
        onChange={onAspectPresetChange}
      />
      <AspectRatioLockButton isLocked={options.aspectLocked} onToggle={onLockToggle} />
    </>
  );
};

export const bboxAdapter: ToolPresentationAdapter = {
  geometry: FramePosition,
  icon: FrameIcon,
  id: 'bbox',
  modes: { component: FrameSize, width: 2 * TOOLBAR_NUMBER_FIELD_WIDTH_PX + 120 + 32 + 3 * TOOLBAR_GAP_PX },
  primary: 'geometry',
};
