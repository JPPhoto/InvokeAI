import type { ToolId } from '@workbench/canvas-engine/api';

import { filterOperationAdapter } from '@workbench/widgets/canvas/tool-options/FilterOptions';
import { bboxForm, moveForm, transformForm } from '@workbench/widgets/canvas/tool-options/geometryForm';
import { gradientForm } from '@workbench/widgets/canvas/tool-options/GradientOptions';
import { brushForm, eraserForm } from '@workbench/widgets/canvas/tool-options/paintForm';
import { selectObjectOperationAdapter } from '@workbench/widgets/canvas/tool-options/SamOptions';
import { lassoForm, marqueeForm } from '@workbench/widgets/canvas/tool-options/selectionForm';
import { shapeForm } from '@workbench/widgets/canvas/tool-options/ShapeOptions';
import { textForm } from '@workbench/widgets/canvas/tool-options/TextOptions';

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
  bbox: bboxForm,
  brush: brushForm,
  colorPicker: hintOnly('colorPicker'),
  eraser: eraserForm,
  gradient: gradientForm,
  lasso: lassoForm,
  marquee: marqueeForm,
  move: moveForm,
  sam: hintOnly('sam'),
  shape: shapeForm,
  text: textForm,
  transform: transformForm,
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
