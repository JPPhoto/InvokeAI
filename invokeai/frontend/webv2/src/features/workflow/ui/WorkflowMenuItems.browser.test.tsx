import type { ProjectGraphState, WorkflowNode } from '@features/workflow/core/types';
import type { WorkflowRuntimeApi } from '@features/workflow/ui/contracts';
import type { WorkflowUiAdapter } from '@features/workflow/ui/WorkflowUiContext';

import { ChakraProvider, Menu } from '@chakra-ui/react';
import { createProjectGraph } from '@features/workflow/utility';
import { system } from '@theme/system';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkflowUiProvider } from './WorkflowUiContext';
import { WorkflowMenuItems } from './WorkflowWidgetChrome';

const { copyWorkflowJsonMock, downloadWorkflowJsonMock } = vi.hoisted(() => ({
  copyWorkflowJsonMock: vi.fn(),
  downloadWorkflowJsonMock: vi.fn(),
}));

vi.mock('./workflowTransfer', () => ({
  copyWorkflowJson: copyWorkflowJsonMock,
  downloadWorkflowJson: downloadWorkflowJsonMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'projects.exportFailed': 'Export failed',
        'widgets.labels.workflow': 'Workflow',
        'widgets.workflow.copyJson': 'Copy workflow JSON',
        'widgets.workflow.copyJsonFailed': 'Failed to copy workflow JSON',
        'widgets.workflow.detailsWithEllipsis': 'Workflow details…',
        'widgets.workflow.exportJson': 'Export workflow JSON',
        'widgets.workflow.importJsonWithEllipsis': 'Import workflow JSON…',
        'widgets.workflow.newWorkflowWithEllipsis': 'New workflow…',
        'workflowLibrary.multipleWorkflowReturnNodesForTransfer':
          'The workflow must contain exactly one workflow return node before it can be exported or copied.',
      })[key] ?? key,
  }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const duplicateReturnGraph = (): ProjectGraphState => ({
  ...createProjectGraph('workflow-1'),
  nodes: [
    { data: { type: 'workflow_return' }, id: 'return-1', position: { x: 0, y: 0 }, type: 'invocation' },
    { data: { type: 'workflow_return' }, id: 'return-2', position: { x: 100, y: 0 }, type: 'invocation' },
  ] as unknown as WorkflowNode[],
});

const TEST_RUNTIME: WorkflowRuntimeApi = {
  commands: { register: () => () => undefined },
  hotkeys: { register: () => () => undefined },
  instanceId: 'workflow-menu-test',
  region: 'center',
  typeId: 'workflow',
};

describe('WorkflowMenuItems duplicate workflow-return feedback', () => {
  let host: HTMLDivElement;
  let root: Root;
  let notifications: WorkflowUiAdapter['notifications'];

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    copyWorkflowJsonMock.mockReset();
    downloadWorkflowJsonMock.mockReset();
    notifications = { error: vi.fn(), info: vi.fn(), success: vi.fn() };
  });

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
  });

  const renderMenu = async () => {
    const graph = duplicateReturnGraph();
    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- intentionally minimal test adapter
    const adapter = {
      getProjectGraph: () => graph,
      notifications,
      widgets: { open: vi.fn(), patchValues: vi.fn() },
    } as unknown as WorkflowUiAdapter;

    await act(() => {
      root.render(
        <ChakraProvider value={system}>
          <WorkflowUiProvider adapter={adapter}>
            <Menu.Root open>
              <Menu.Positioner>
                <Menu.Content>
                  <WorkflowMenuItems region="center" runtime={TEST_RUNTIME} />
                </Menu.Content>
              </Menu.Positioner>
            </Menu.Root>
          </WorkflowUiProvider>
        </ChakraProvider>
      );
    });
  };

  it('blocks export and copy with action-specific translated feedback', async () => {
    await renderMenu();

    const menuItems = () => Array.from(host.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const exportItem = () => menuItems().find((item) => item.textContent === 'Export workflow JSON');
    const copyItem = () => menuItems().find((item) => item.textContent === 'Copy workflow JSON');

    await act(() => exportItem()?.click());
    await act(() => copyItem()?.click());

    expect(downloadWorkflowJsonMock).not.toHaveBeenCalled();
    expect(copyWorkflowJsonMock).not.toHaveBeenCalled();
    expect(notifications.error).toHaveBeenNthCalledWith(
      1,
      'Export failed',
      'The workflow must contain exactly one workflow return node before it can be exported or copied.'
    );
    expect(notifications.error).toHaveBeenNthCalledWith(
      2,
      'Failed to copy workflow JSON',
      'The workflow must contain exactly one workflow return node before it can be exported or copied.'
    );
  });
});
