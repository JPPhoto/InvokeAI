import type { ToolId } from '@workbench/canvas-engine/api';

import { bboxAdapter } from '@workbench/widgets/canvas/tool-options/BboxOptions';
import { brushAdapter } from '@workbench/widgets/canvas/tool-options/BrushOptions';
import { eraserAdapter } from '@workbench/widgets/canvas/tool-options/EraserOptions';
import { filterOperationAdapter } from '@workbench/widgets/canvas/tool-options/FilterOptions';
import { gradientAdapter } from '@workbench/widgets/canvas/tool-options/GradientOptions';
import { lassoAdapter } from '@workbench/widgets/canvas/tool-options/LassoOptions';
import { marqueeAdapter } from '@workbench/widgets/canvas/tool-options/MarqueeOptions';
import { moveAdapter } from '@workbench/widgets/canvas/tool-options/MoveOptions';
import { selectObjectOperationAdapter } from '@workbench/widgets/canvas/tool-options/SamOptions';
import { shapeAdapter } from '@workbench/widgets/canvas/tool-options/ShapeOptions';
import { textAdapter } from '@workbench/widgets/canvas/tool-options/TextOptions';
import { transformAdapter } from '@workbench/widgets/canvas/tool-options/TransformOptions';
import { HandIcon, PipetteIcon, ScanSearchIcon } from 'lucide-react';

import type { CanvasOperationKind, OperationPresentationAdapter, ToolPresentationAdapter } from './toolbarContracts';

/** Tools with no primary settings show their name and hint; the shell never unmounts for them. */
const hintOnly = (id: ToolId, icon: ToolPresentationAdapter['icon']): ToolPresentationAdapter => ({
  icon,
  id,
  primary: null,
});

export const TOOL_PRESENTATION_ADAPTERS: Readonly<Record<ToolId, ToolPresentationAdapter>> = {
  bbox: bboxAdapter,
  brush: brushAdapter,
  colorPicker: hintOnly('colorPicker', PipetteIcon),
  eraser: eraserAdapter,
  gradient: gradientAdapter,
  lasso: lassoAdapter,
  marquee: marqueeAdapter,
  move: moveAdapter,
  sam: hintOnly('sam', ScanSearchIcon),
  shape: shapeAdapter,
  text: textAdapter,
  transform: transformAdapter,
  view: hintOnly('view', HandIcon),
};

export const OPERATION_PRESENTATION_ADAPTERS: Readonly<Record<CanvasOperationKind, OperationPresentationAdapter>> = {
  filter: filterOperationAdapter,
  'select-object': selectObjectOperationAdapter,
};

export const hasToolRegions = (adapter: ToolPresentationAdapter): boolean =>
  !!(adapter.geometry || adapter.intensity || adapter.color || adapter.modes || adapter.more || adapter.status);
