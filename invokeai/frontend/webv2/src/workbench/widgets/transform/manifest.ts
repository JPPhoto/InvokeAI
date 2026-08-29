import type { WidgetManifest } from '@workbench/widgetContracts';

import { Rotate3dIcon } from 'lucide-react';

export const transformWidgetManifest: WidgetManifest = {
  allowMultiple: false,
  allowedRegions: ['right'],
  failurePolicy: { isolateRenderFailure: true, onRegistrationFailure: 'disable' },
  icon: Rotate3dIcon,
  id: 'transform',
  label: (t) => t('widgets.labels.transform'),
  load: () => import('./implementation').then((module) => module.widgetImplementation),
  rightDock: 'rightBottom',
  version: 1,
};
