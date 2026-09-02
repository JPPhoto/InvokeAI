import type {
  ToolbarRegionProps,
  ToolbarStatusProps,
  ToolPresentationAdapter,
} from '@workbench/widgets/canvas/tool-presentation/toolbarContracts';

import { useEraserOptions } from '@workbench/widgets/canvas/engineStoreHooks';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import {
  clampBrushSize,
  PaintHardnessControl,
  PaintOpacityControl,
  PaintSizeControl,
  PaintStrokePreview,
} from './BrushOptions';

const EraserSize = ({ engine }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const options = useEraserOptions(engine);
  const setSize = useCallback(
    (size: number) => engine.interaction.set('eraserOptions', { ...options, size: clampBrushSize(size) }),
    [engine, options]
  );
  return <PaintSizeControl label={t('widgets.canvas.toolOptions.eraserSize')} setSize={setSize} size={options.size} />;
};

const EraserOpacity = ({ engine }: ToolbarRegionProps) => {
  const options = useEraserOptions(engine);
  const setOpacity = useCallback(
    (opacity: number) => engine.interaction.set('eraserOptions', { ...options, opacity }),
    [engine, options]
  );
  return <PaintOpacityControl opacity={options.opacity} setOpacity={setOpacity} />;
};

const EraserHardness = ({ engine }: ToolbarRegionProps) => {
  const options = useEraserOptions(engine);
  const setHardness = useCallback(
    (hardness: number) => engine.interaction.set('eraserOptions', { ...options, hardness }),
    [engine, options]
  );
  return <PaintHardnessControl hardness={options.hardness} setHardness={setHardness} />;
};

const EraserPreview = ({ engine }: ToolbarStatusProps) => {
  const options = useEraserOptions(engine);
  return (
    <PaintStrokePreview color="#9aa2b1" hardness={options.hardness} opacity={options.opacity} size={options.size} />
  );
};

export const eraserAdapter: ToolPresentationAdapter = {
  rowLabels: {
    geometry: 'widgets.canvas.toolOptions.size',
    intensity: 'widgets.canvas.toolOptions.opacity',
    modes: 'widgets.canvas.toolOptions.hardness',
  },
  geometry: EraserSize,
  id: 'eraser',
  intensity: EraserOpacity,
  modes: EraserHardness,
  paintsLeaf: true,
  status: EraserPreview,
};
