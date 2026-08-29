import type {
  ToolbarRegionProps,
  ToolPresentationAdapter,
} from '@workbench/widgets/canvas/tool-presentation/toolbarContracts';

import { useEraserOptions } from '@workbench/widgets/canvas/engineStoreHooks';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { clampBrushSize, PaintOpacityControl, PaintSizeControl } from './BrushOptions';

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

export const eraserAdapter: ToolPresentationAdapter = {
  rowLabels: { geometry: 'widgets.canvas.toolOptions.size', intensity: 'widgets.canvas.toolOptions.opacity' },
  geometry: EraserSize,
  id: 'eraser',
  intensity: EraserOpacity,
  paintsLeaf: true,
};
