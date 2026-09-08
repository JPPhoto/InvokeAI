import type {
  ToolFormComponent,
  ToolPropertyForm,
} from '@workbench/widgets/canvas/tool-presentation/toolFormContracts';

import { Skeleton } from '@chakra-ui/react';
import { lazy, Suspense } from 'react';

const loading = <Skeleton height="8" />;

// Catalog queries and variable-font controls are needed only while text is selected.
const lazyGroup = (load: () => Promise<{ default: ToolFormComponent }>): ToolFormComponent => {
  const Body = lazy(load);
  return (props) => (
    <Suspense fallback={loading}>
      <Body {...props} />
    </Suspense>
  );
};

export const textForm: ToolPropertyForm = {
  groups: [
    {
      body: lazyGroup(() => import('./TextOptions').then((module) => ({ default: module.TextFontSettings }))),
      id: 'text-font',
      labelKey: 'widgets.properties.groups.font',
    },
    {
      body: lazyGroup(() => import('./TextOptions').then((module) => ({ default: module.TextParagraphSettings }))),
      id: 'text-paragraph',
      labelKey: 'widgets.properties.groups.paragraph',
    },
    {
      body: lazyGroup(() => import('./TextOptions').then((module) => ({ default: module.TextColorSettings }))),
      id: 'text-color',
      labelKey: 'widgets.properties.rows.color',
    },
  ],
  id: 'text',
  paintsLeaf: true,
};
