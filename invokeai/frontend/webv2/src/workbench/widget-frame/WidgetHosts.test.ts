import { describe, expect, it } from 'vitest';

import { projectHasWidgetType } from './WidgetHosts';

const project = (instanceIds: string[], floatingIds: string[] = []) => ({
  floatingWidgets: Object.fromEntries(floatingIds.map((id) => [id, {}])),
  widgetInstances: Object.fromEntries(
    [...instanceIds, ...floatingIds].map((id) => [id, { id, typeId: id.startsWith('workflow') ? 'workflow' : 'queue' }])
  ),
  widgetRegions: {
    center: { instanceIds },
    left: { instanceIds: [] },
    right: { instanceIds: [] },
    bottom: { instanceIds: [] },
  },
});

describe('projectHasWidgetType', () => {
  it('finds widget types mounted in regions', () => {
    expect(projectHasWidgetType(project(['workflow-1']), 'workflow')).toBe(true);
    expect(projectHasWidgetType(project(['queue-1']), 'workflow')).toBe(false);
  });

  it('finds widget types mounted in floating windows', () => {
    expect(projectHasWidgetType(project([], ['workflow-1']), 'workflow')).toBe(true);
  });
});
