// @vitest-environment happy-dom
import { buildEdge, buildNode, for_loop, for_return } from 'features/nodes/store/util/testUtils';
import type { AnyEdge, AnyNode } from 'features/nodes/types/invocation';
import type { ReactNode } from 'react';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LoopBodyBoundaryOverlay from './LoopBodyBoundaryOverlay';

const flowMocks = vi.hoisted(() => ({
  nodes: [] as AnyNode[],
  getNodesBounds: vi.fn(() => ({ x: 10, y: 20, width: 100, height: 200 })),
}));

vi.mock('@xyflow/react', () => ({
  useNodes: () => flowMocks.nodes,
  useReactFlow: () => ({ getNodesBounds: flowMocks.getNodesBounds }),
  ViewportPortal: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@invoke-ai/ui-library', () => ({
  Box: ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) => {
    const domProps = Object.fromEntries(
      Object.entries(props).filter(([key]) => key === 'title' || key.startsWith('aria-') || key.startsWith('data-'))
    );
    return <div {...domProps}>{children}</div>;
  },
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { bodyId?: string }) => {
      if (key === 'nodes.forLoopBodyBoundaryWithIdentity') {
        return `For loop body (${options?.bodyId})`;
      }
      if (key === 'nodes.forLoopBodyBoundaryLegacy') {
        return 'For loop body (legacy identity)';
      }
      if (key === 'nodes.forLoopBodyBoundaryStatus.identity_mismatch') {
        return 'mismatched body identity';
      }
      return key;
    },
  }),
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const setNodeId = (node: AnyNode, id: string): AnyNode => {
  node.id = id;
  node.data.id = id;
  return node;
};

const setBodyId = (node: AnyNode, bodyId: string | undefined) => {
  if (node.type !== 'invocation' || !node.data.inputs.body_id) {
    throw new Error('Expected a loop boundary node');
  }
  node.data.inputs.body_id.value = bodyId;
};

const edge = (source: string, sourceHandle: string, target: string, targetHandle: string): AnyEdge =>
  buildEdge(source, sourceHandle, target, targetHandle);

describe('LoopBodyBoundaryOverlay', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    flowMocks.nodes = [];
    flowMocks.getNodesBounds.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  const renderBoundary = (forBodyId: string | undefined, returnBodyId: string | undefined) => {
    const forNode = setNodeId(buildNode(for_loop), 'for');
    const returnNode = setNodeId(buildNode(for_return), 'return');
    setBodyId(forNode, forBodyId);
    setBodyId(returnNode, returnBodyId);
    flowMocks.nodes = [forNode, returnNode];

    act(() => {
      root.render(<LoopBodyBoundaryOverlay edges={[edge('for', 'item', 'return', 'output')]} />);
    });
  };

  it('renders the renamed label with a shortened durable identity', () => {
    renderBoundary('body-123456789', 'body-123456789');

    const boundary = container.querySelector('[data-loop-body-boundary="for"]');
    expect(boundary?.getAttribute('aria-label')).toBe('For loop body (body-123...)');
    expect(boundary?.textContent).toBe('For loop body (body-123...)');
    expect(boundary?.getAttribute('data-loop-body-status')).toBe('complete');
  });

  it('labels a legacy boundary without durable identity', () => {
    renderBoundary(undefined, undefined);

    const boundary = container.querySelector('[data-loop-body-boundary="for"]');
    expect(boundary?.getAttribute('aria-label')).toBe('For loop body (legacy identity)');
    expect(boundary?.textContent).toBe('For loop body (legacy identity)');
  });

  it('includes validation status in the label for a mismatched identity', () => {
    renderBoundary('body-1', 'body-2');

    const boundary = container.querySelector('[data-loop-body-boundary="for"]');
    expect(boundary?.getAttribute('aria-label')).toBe('For loop body (body-1) - mismatched body identity');
    expect(boundary?.getAttribute('data-loop-body-status')).toBe('identity_mismatch');
  });
});
