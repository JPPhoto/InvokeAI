import type { WidgetImplementation } from '@workbench/widgetContracts';

import { TransformWidgetView } from './TransformWidgetView';

export const widgetImplementation = {
  view: TransformWidgetView,
} satisfies WidgetImplementation;
