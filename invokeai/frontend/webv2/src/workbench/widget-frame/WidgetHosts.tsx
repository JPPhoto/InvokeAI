import { getWidgetHosts } from '@workbench/widgetRegistry';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { Suspense, use } from 'react';

import { WidgetFailureBoundary } from './WidgetFailureBoundary';

type WidgetHostProject = {
  floatingWidgets?: Record<string, unknown>;
  widgetInstances: Record<string, { typeId?: string }>;
  widgetRegions: Record<string, { instanceIds: string[] }>;
};

export const projectHasWidgetType = (project: WidgetHostProject, widgetTypeId: string): boolean => {
  const regionInstanceIds = Object.values(project.widgetRegions).flatMap((region) => region.instanceIds);
  const floatingInstanceIds = Object.keys(project.floatingWidgets ?? {});

  return [...regionInstanceIds, ...floatingInstanceIds].some(
    (instanceId) => project.widgetInstances[instanceId]?.typeId === widgetTypeId
  );
};

const WidgetHost = ({ widget }: { widget: ReturnType<typeof getWidgetHosts>[number] }) => {
  const Host = use(widget.host!.load());

  // react-compiler flags any JSX tag that is directly the value returned by
  // `use()` as though it were freshly created each render. `Host` is the
  // module's cached export, resolved once by the deferred resource and
  // stable across renders; the false positive disappears the moment the
  // value is read through a property access instead of being the call's
  // direct result, which is what the sibling `WidgetRenderer` slots do.
  // eslint-disable-next-line react/static-components
  return <Host />;
};

const WidgetHostBoundary = ({ widget }: { widget: ReturnType<typeof getWidgetHosts>[number] }) => {
  const content = (
    <Suspense fallback={null}>
      <WidgetHost widget={widget} />
    </Suspense>
  );

  return widget.manifest.failurePolicy.isolateRenderFailure ? (
    <WidgetFailureBoundary
      resetKey={widget.manifest.id}
      widget={widget}
      widgetId={widget.manifest.id}
      onRetry={widget.host!.retry}
    >
      {content}
    </WidgetFailureBoundary>
  ) : (
    content
  );
};

export const WidgetHosts = () => {
  const hasWorkflowWidget = useActiveProjectSelector((project) => projectHasWidgetType(project, 'workflow'));
  const widgets = getWidgetHosts().filter((widget) => widget.manifest.id !== 'workflow' || hasWorkflowWidget);

  return (
    <>
      {widgets.map((widget) => (
        <WidgetHostBoundary key={widget.manifest.id} widget={widget} />
      ))}
    </>
  );
};
