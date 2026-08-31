import type { WidgetManifest } from '@workbench/widgetContracts';

import { LayersIcon } from 'lucide-react';

import { LAYER_EDITOR_PANE_DEFAULTS } from './panes/editorPaneLayout';

export const layersWidgetManifest: WidgetManifest = {
  allowMultiple: false,
  allowedRegions: ['right'],
  failurePolicy: { isolateRenderFailure: true, onRegistrationFailure: 'disable' },
  icon: LayersIcon,
  id: 'layers',
  label: (t) => t('widgets.labels.layers'),
  load: () => import('./implementation').then((module) => module.widgetImplementation),
  state: {
    createInitial: () => ({ editorPanes: { ...LAYER_EDITOR_PANE_DEFAULTS } }),
    persistence: 'project',
    version: 1,
  },
  version: 1,
};
