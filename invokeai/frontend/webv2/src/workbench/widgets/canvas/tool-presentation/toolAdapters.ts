import type { ToolId } from '@workbench/canvas-engine/api';

import { bboxAdapter } from '@workbench/widgets/canvas/tool-options/BboxOptions';
import { filterOperationAdapter } from '@workbench/widgets/canvas/tool-options/FilterOptions';
import { gradientAdapter } from '@workbench/widgets/canvas/tool-options/GradientOptions';
import { lassoAdapter } from '@workbench/widgets/canvas/tool-options/LassoOptions';
import { marqueeAdapter } from '@workbench/widgets/canvas/tool-options/MarqueeOptions';
import { moveAdapter } from '@workbench/widgets/canvas/tool-options/MoveOptions';
import { brushForm, eraserForm } from '@workbench/widgets/canvas/tool-options/paintForm';
import { selectObjectOperationAdapter } from '@workbench/widgets/canvas/tool-options/SamOptions';
import { shapeAdapter } from '@workbench/widgets/canvas/tool-options/ShapeOptions';
import { textAdapter } from '@workbench/widgets/canvas/tool-options/TextOptions';
import { transformAdapter } from '@workbench/widgets/canvas/tool-options/TransformOptions';

import type {
  CanvasOperationKind,
  OperationPresentationAdapter,
  ToolPanePresentation,
  ToolPresentationAdapter,
} from './toolbarContracts';

import { isToolPropertyForm } from './toolbarContracts';

/** Tools with no primary settings show their name and hint; the shell never unmounts for them. */
const hintOnly = (id: ToolId): ToolPresentationAdapter => ({ id });

export const TOOL_PRESENTATION_ADAPTERS: Readonly<Record<ToolId, ToolPanePresentation>> = {
  bbox: bboxAdapter,
  brush: brushForm,
  colorPicker: hintOnly('colorPicker'),
  eraser: eraserForm,
  gradient: gradientAdapter,
  lasso: lassoAdapter,
  marquee: marqueeAdapter,
  move: moveAdapter,
  sam: hintOnly('sam'),
  shape: shapeAdapter,
  text: textAdapter,
  transform: transformAdapter,
  view: hintOnly('view'),
};

export const OPERATION_PRESENTATION_ADAPTERS: Readonly<Record<CanvasOperationKind, OperationPresentationAdapter>> = {
  filter: filterOperationAdapter,
  'select-object': selectObjectOperationAdapter,
};

export const hasToolRegions = (adapter: ToolPresentationAdapter): boolean =>
  !!(adapter.geometry || adapter.intensity || adapter.color || adapter.modes || adapter.more || adapter.status);

/** Whether the pane has anything to render for the tool beyond its name and hint. */
export const hasToolControls = (adapter: ToolPanePresentation): boolean =>
  isToolPropertyForm(adapter) ? adapter.groups.length > 0 : hasToolRegions(adapter);

export { isToolPropertyForm };
