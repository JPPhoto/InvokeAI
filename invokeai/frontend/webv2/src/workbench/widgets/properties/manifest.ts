import type { WidgetManifest } from '@workbench/widgetContracts';

import { SlidersHorizontalIcon } from 'lucide-react';

export const propertiesWidgetManifest: WidgetManifest = {
  allowMultiple: false,
  allowedRegions: ['right'],
  failurePolicy: { isolateRenderFailure: true, onRegistrationFailure: 'disable' },
  icon: SlidersHorizontalIcon,
  id: 'properties',
  label: (t) => t('widgets.labels.properties'),
  load: () => import('./implementation').then((module) => module.widgetImplementation),
  rightDock: 'rightBottom',
  version: 1,
};
