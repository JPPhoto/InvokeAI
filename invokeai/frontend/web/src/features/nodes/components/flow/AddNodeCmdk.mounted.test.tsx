// @vitest-environment happy-dom
import { applyEdgeChanges, applyNodeChanges } from '@xyflow/react';
import { CONNECTOR_INPUT_HANDLE, CONNECTOR_OUTPUT_HANDLE } from 'features/nodes/store/util/connectorTopology';
import {
  $addNodeCmdk,
  $cursorPos,
  $edgePendingUpdate,
  $pendingConnection,
  $templates,
  edgesChanged,
  nodesChanged,
} from 'features/nodes/store/nodesSlice';
import type { PendingConnection } from 'features/nodes/store/types';
import { buildEdge, buildLoopLinkageEdge, buildNode, for_loop, for_return } from 'features/nodes/store/util/testUtils';
import type { AnyEdge, AnyNode } from 'features/nodes/types/invocation';
import type { ChangeEvent, ReactNode } from 'react';
import * as React from 'react';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  nodes: [] as AnyNode[],
  edges: [] as AnyEdge[],
  dispatch: vi.fn(),
  buildNode: vi.fn(),
}));

vi.mock('app/store/storeHooks', () => {
  const getState = () => ({
    nodes: { present: { nodes: mocks.nodes, edges: mocks.edges } },
    ui: { activeTab: 'workflows' },
    workflowSettings: { shouldGroupNodesByCategory: false },
  });

  return {
    useAppDispatch: () => mocks.dispatch,
    useAppSelector: (selector: (state: ReturnType<typeof getState>) => unknown) => selector(getState()),
    useAppStore: () => ({ getState, dispatch: mocks.dispatch }),
  };
});

vi.mock('features/nodes/hooks/useBuildNode', () => ({
  useBuildNode: () => mocks.buildNode,
}));

vi.mock('features/system/components/HotkeysModal/useHotkeyData', () => ({
  useRegisteredHotkeys: () => undefined,
}));

vi.mock('features/toast/toast', () => ({
  toast: vi.fn(),
}));

vi.mock('common/components/IAIImageFallback', () => ({
  IAINoContentFallback: () => null,
}));

vi.mock('common/components/OverlayScrollbars/ScrollableContent', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'nodes.nodeSearch': 'Search nodes',
        'common.noMatchingItems': 'No matching items',
        'common.expandAll': 'Expand all',
        'common.collapseAll': 'Collapse all',
      })[key] ?? key,
  }),
}));

vi.mock('@invoke-ai/ui-library', () => {
  type Props = {
    children?: ReactNode;
    onClick?: () => void;
    onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
    placeholder?: string;
    value?: string;
    [key: string]: unknown;
  };

  const getDomProps = ({ children: _children, ...props }: Props): React.HTMLAttributes<HTMLElement> =>
    Object.fromEntries(
      Object.entries(props).filter(
        ([key]) =>
          key === 'aria-label' ||
          key === 'onClick' ||
          key === 'onChange' ||
          key === 'onKeyDown' ||
          key === 'onPointerMove' ||
          key === 'placeholder' ||
          key === 'role' ||
          key === 'tabIndex' ||
          key === 'value' ||
          key.startsWith('aria-') ||
          key.startsWith('data-')
      )
    ) as React.HTMLAttributes<HTMLElement>;

  const Flex = React.forwardRef<HTMLDivElement, Props>(function Flex(
    { children, ...props }: Props,
    ref: React.ForwardedRef<HTMLDivElement>
  ) {
    return (
      <div ref={ref} {...getDomProps({ children, ...props })}>
        {children}
      </div>
    );
  });
  const Input = React.forwardRef<HTMLInputElement, Props>(function Input(
    { children, ...props }: Props,
    ref: React.ForwardedRef<HTMLInputElement>
  ) {
    return <input ref={ref} {...getDomProps({ children, ...props })} />;
  });
  const Box = ({ children }: Props) => <div>{children}</div>;
  const Text = ({ children }: Props) => <span>{children}</span>;
  const Button = ({ children, ...props }: Props) => (
    <button {...getDomProps({ children, ...props })}>{children}</button>
  );
  const Modal = ({ children, isOpen }: Props & { isOpen?: boolean }) => (isOpen ? <div>{children}</div> : null);
  const passthrough = ({ children }: Props) => <div>{children}</div>;
  const Icon = () => <span />;
  const ModalOverlay = () => null;
  const Spacer = () => <span />;

  Box.displayName = 'Box';
  Text.displayName = 'Text';
  Button.displayName = 'Button';
  Modal.displayName = 'Modal';
  passthrough.displayName = 'passthrough';
  Icon.displayName = 'Icon';
  ModalOverlay.displayName = 'ModalOverlay';
  Spacer.displayName = 'Spacer';

  return {
    Box,
    Button,
    Flex,
    Icon,
    Input,
    Modal,
    ModalBody: passthrough,
    ModalContent: passthrough,
    ModalOverlay,
    Portal: passthrough,
    Spacer,
    Text,
  };
});

import { AddNodeCmdk } from './AddNodeCmdk/AddNodeCmdk';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const setNodeId = (node: AnyNode, id: string): AnyNode => {
  node.id = id;
  node.data.id = id;
  return node;
};

const buildConnector = (id: string): AnyNode => ({
  id,
  type: 'connector',
  position: { x: 0, y: 0 },
  data: {
    id,
    type: 'connector',
    label: 'Connector',
    isOpen: true,
  },
});

describe('AddNodeCmdk (mounted)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    const forNode = setNodeId(buildNode(for_loop), 'for-node');
    mocks.nodes = [forNode];
    mocks.edges = [];
    mocks.dispatch.mockReset();
    mocks.dispatch.mockImplementation((action: unknown) => {
      if (nodesChanged.match(action)) {
        mocks.nodes = applyNodeChanges(action.payload, mocks.nodes);
      }
      if (edgesChanged.match(action)) {
        mocks.edges = applyEdgeChanges(action.payload, mocks.edges);
      }
      return action;
    });
    mocks.buildNode.mockReset();
    mocks.buildNode.mockReturnValue(setNodeId(buildNode(for_return), 'return-node'));

    $templates.set({ for: for_loop, for_return });
    $addNodeCmdk.set(true);
    $cursorPos.set({ x: 0, y: 0 });
    $edgePendingUpdate.set(null);
    $pendingConnection.set({
      nodeId: 'for-node',
      handleId: 'item',
      handleType: 'source',
      fieldTemplate: for_loop.outputs.item as PendingConnection['fieldTemplate'],
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    $addNodeCmdk.set(false);
    $cursorPos.set(null);
    $edgePendingUpdate.set(null);
    $pendingConnection.set(null);
    $templates.set({});
  });

  it('adds ForReturn with loop linkage and auto-connects its output', () => {
    act(() => {
      root.render(<AddNodeCmdk />);
    });

    const returnItem = Array.from(container.querySelectorAll('[role="button"]')).find((element) =>
      element.textContent?.trim().startsWith('ForReturn')
    );
    expect(returnItem).toBeDefined();

    act(() => {
      returnItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.edges).toEqual([
      expect.objectContaining({
        source: 'for-node',
        sourceHandle: 'item',
        target: 'return-node',
        targetHandle: 'output',
      }),
      expect.objectContaining({
        type: 'loop_linkage',
        source: 'for-node',
        sourceHandle: 'loop_linkage',
        target: 'return-node',
        targetHandle: 'loop_linkage',
      }),
    ]);
    expect($addNodeCmdk.get()).toBe(false);
    expect($pendingConnection.get()).toBeNull();
  });

  it('adds loop linkage when an iteration output is routed through a connector', () => {
    const connector = buildConnector('connector');
    mocks.nodes = [mocks.nodes[0]!, connector];
    mocks.edges = [buildEdge('for-node', 'item', connector.id, CONNECTOR_INPUT_HANDLE)];
    $pendingConnection.set({
      nodeId: connector.id,
      handleId: CONNECTOR_OUTPUT_HANDLE,
      handleType: 'source',
      fieldTemplate: {
        ...for_loop.outputs.item,
        name: CONNECTOR_OUTPUT_HANDLE,
      } as PendingConnection['fieldTemplate'],
    });

    act(() => {
      root.render(<AddNodeCmdk />);
    });

    const returnItem = Array.from(container.querySelectorAll('[role="button"]')).find((element) =>
      element.textContent?.trim().startsWith('ForReturn')
    );
    act(() => {
      returnItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.edges).toContainEqual(
      expect.objectContaining({
        type: 'loop_linkage',
        source: 'for-node',
        sourceHandle: 'loop_linkage',
        target: 'return-node',
        targetHandle: 'loop_linkage',
      })
    );
  });

  it('does not add a duplicate linkage when the For is already paired', () => {
    const existingReturn = setNodeId(buildNode(for_return), 'existing-return');
    mocks.nodes = [mocks.nodes[0]!, existingReturn];
    mocks.edges = [buildLoopLinkageEdge('for-node', existingReturn.id)];

    act(() => {
      root.render(<AddNodeCmdk />);
    });

    const returnItem = Array.from(container.querySelectorAll('[role="button"]')).find((element) =>
      element.textContent?.trim().startsWith('ForReturn')
    );
    act(() => {
      returnItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.edges.filter((edge) => edge.type === 'loop_linkage')).toEqual([
      buildLoopLinkageEdge('for-node', existingReturn.id),
    ]);
  });
});
