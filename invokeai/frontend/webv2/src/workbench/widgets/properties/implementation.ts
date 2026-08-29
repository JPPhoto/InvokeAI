import type { WidgetImplementation } from '@workbench/widgetContracts';

import { PropertiesWidgetView } from './PropertiesWidgetView';

export const widgetImplementation = {
  view: PropertiesWidgetView,
} satisfies WidgetImplementation;
