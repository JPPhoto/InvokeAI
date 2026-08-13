import { ReactFlowProvider, type ReactFlowInstance } from '@xyflow/react';
import ThemeLocaleProvider from 'app/components/ThemeLocaleProvider';
import { createStore } from 'app/store/store';
import { AddNodeCmdk } from 'features/nodes/components/flow/AddNodeCmdk/AddNodeCmdk';
import { Flow } from 'features/nodes/components/flow/Flow';
import {
  $addNodeCmdk,
  $cursorPos,
  $pendingConnection,
  $templates,
  nodesChanged,
} from 'features/nodes/store/nodesSlice';
import { $flow } from 'features/nodes/store/reactFlowInstance';
import type { PendingConnection } from 'features/nodes/store/types';
import { for_loop, for_return, templates } from 'features/nodes/store/util/testUtils';
import type { AnyEdge, AnyNode } from 'features/nodes/types/invocation';
import { buildInvocationNode } from 'features/nodes/util/node/buildInvocationNode';
import i18next from 'i18next';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { Provider } from 'react-redux';
import { expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';

const testTemplates = { ...templates, for: for_loop, for_return };
const translationEN = {
  nodes: {
    nodeSearch: 'Search nodes',
    unknownNode: 'Unknown node',
    expandAll: 'Expand all',
    collapseAll: 'Collapse all',
  },
  common: {
    noMatchingItems: 'No matching items',
  },
};

const testI18n = i18next.createInstance().use(initReactI18next);

const TestProviders = ({ children, store }: { children: ReactNode; store: ReturnType<typeof createStore> }) => (
  <Provider store={store}>
    <I18nextProvider i18n={testI18n}>
      <ThemeLocaleProvider>{children}</ThemeLocaleProvider>
    </I18nextProvider>
  </Provider>
);

const createFlowStub = () =>
  ({
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
  }) as ReactFlowInstance<AnyNode, AnyEdge>;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

test.beforeEach(async () => {
  if (!testI18n.isInitialized) {
    await testI18n.init({
      lng: 'en',
      fallbackLng: 'en',
      resources: { en: { translation: translationEN } },
      interpolation: { escapeValue: false },
      returnNull: false,
    });
  } else {
    testI18n.addResourceBundle('en', 'translation', translationEN, true, true);
    await testI18n.changeLanguage('en');
  }

  $templates.set(testTemplates);
  $addNodeCmdk.set(true);
  $cursorPos.set({ x: 0, y: 0 });
  $flow.set(createFlowStub());
  $pendingConnection.set(null);
  container = document.createElement('div');
  container.style.width = '1200px';
  container.style.height = '800px';
  document.body.append(container);
});

test.afterEach(() => {
  root?.unmount();
  root = undefined;
  container?.remove();
  container = undefined;
  $addNodeCmdk.set(false);
  $pendingConnection.set(null);
  $templates.set({});
  $flow.set(null);
});

test('selects ForReturn from an iteration output and auto-wires its output input', async () => {
  const store = createStore({ persist: false });

  const forNode = buildInvocationNode({ x: 0, y: 0 }, for_loop);
  store.dispatch(nodesChanged([{ type: 'add', item: forNode }]));

  const pendingConnection: PendingConnection = {
    nodeId: forNode.id,
    handleId: 'item',
    handleType: 'source',
    fieldTemplate: for_loop.outputs.item as PendingConnection['fieldTemplate'],
  };
  $pendingConnection.set(pendingConnection);

  root = createRoot(container!);
  root.render(
    <TestProviders store={store}>
      <AddNodeCmdk />
    </TestProviders>
  );

  await expect.element(page.getByText('ForReturn', { exact: true })).toBeVisible();
  await page.getByText('ForReturn', { exact: true }).click();

  const nodes = store.getState().nodes.present.nodes;
  const returnNode = nodes.find((node) => node.data.type === 'for_return');
  expect(returnNode).toBeDefined();
  expect(store.getState().nodes.present.edges).toEqual([
    expect.objectContaining({
      source: forNode.id,
      sourceHandle: 'item',
      target: returnNode!.id,
      targetHandle: 'output',
    }),
  ]);
  expect($addNodeCmdk.get()).toBe(false);
  expect($pendingConnection.get()).toBeNull();
});

test('discovers ForReturn by dragging an iteration output onto the canvas and renders the edge', async () => {
  const store = createStore({ persist: false });
  const forNode = buildInvocationNode({ x: 0, y: 0 }, for_loop);
  forNode.id = 'for-node';
  forNode.data.id = forNode.id;
  store.dispatch(nodesChanged([{ type: 'add', item: forNode }]));

  root = createRoot(container!);
  root.render(
    <TestProviders store={store}>
      <ReactFlowProvider>
        <Flow />
        <AddNodeCmdk />
      </ReactFlowProvider>
    </TestProviders>
  );

  await expect.element(page.getByText('For', { exact: true })).toBeVisible();
  const sourceHandleElement = document.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${forNode.id}"] .react-flow__handle.source[data-handleid="item"]`
  );
  const paneElement = document.querySelector<HTMLElement>('.react-flow__pane');
  expect(sourceHandleElement).not.toBeNull();
  expect(paneElement).not.toBeNull();

  await userEvent.dragAndDrop(page.elementLocator(sourceHandleElement!), page.elementLocator(paneElement!));
  await expect.element(page.getByText('ForReturn', { exact: true })).toBeVisible();
  await page.getByText('ForReturn', { exact: true }).click();

  const returnNode = store.getState().nodes.present.nodes.find((node) => node.data.type === 'for_return');
  expect(returnNode).toBeDefined();
  const edge = store
    .getState()
    .nodes.present.edges.find((candidate) => candidate.source === forNode.id && candidate.target === returnNode!.id);
  expect(edge).toEqual(
    expect.objectContaining({
      sourceHandle: 'item',
      targetHandle: 'output',
    })
  );

  const renderedEdgePath = document.querySelector<SVGPathElement>('.react-flow__edge-path');
  expect(renderedEdgePath).not.toBeNull();
  await expect.element(page.elementLocator(renderedEdgePath!)).toBeVisible();
});
