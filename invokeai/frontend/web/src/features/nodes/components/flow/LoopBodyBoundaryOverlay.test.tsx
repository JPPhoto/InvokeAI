// @vitest-environment happy-dom
import { buildEdge, buildLoopLinkageEdge, buildNode, for_loop, for_return } from 'features/nodes/store/util/testUtils';
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
    t: (key: string) => {
      if (key === 'nodes.forLoopBodyBoundary') {
        return 'For loop body';
      }
      if (key === 'nodes.forLoopBodyBoundaryStatus.invalid_linkage') {
        return 'invalid loop linkage';
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

  const renderBoundary = (withLinkage: boolean) => {
    const forNode = setNodeId(buildNode(for_loop), 'for');
    const returnNode = setNodeId(buildNode(for_return), 'return');
    flowMocks.nodes = [forNode, returnNode];

    act(() => {
      root.render(
        <LoopBodyBoundaryOverlay
          edges={[
            edge('for', 'item', 'return', 'output'),
            ...(withLinkage ? [buildLoopLinkageEdge('for', 'return')] : []),
          ]}
        />
      );
    });
  };

  it('renders the loop body label for a valid linkage', () => {
    renderBoundary(true);

    const boundary = container.querySelector('[data-loop-body-boundary="for"]');
    expect(boundary?.getAttribute('aria-label')).toBe('For loop body');
    expect(boundary?.textContent).toBe('For loop body');
    expect(boundary?.getAttribute('data-loop-body-status')).toBe('complete');
  });

  it('labels a body with missing linkage', () => {
    renderBoundary(false);

    const boundary = container.querySelector('[data-loop-body-boundary="for"]');
    expect(boundary?.getAttribute('aria-label')).toBe(
      'For loop body - nodes.forLoopBodyBoundaryStatus.missing_linkage'
    );
    expect(boundary?.getAttribute('data-loop-body-status')).toBe('missing_linkage');
  });

  it('includes validation status for a detached linkage', () => {
    const forNode = setNodeId(buildNode(for_loop), 'for');
    const returnNode = setNodeId(buildNode(for_return), 'return');
    flowMocks.nodes = [forNode, returnNode];

    act(() => {
      root.render(<LoopBodyBoundaryOverlay edges={[buildLoopLinkageEdge('for', 'return')]} />);
    });

    const boundary = container.querySelector('[data-loop-body-boundary="for"]');
    expect(boundary?.getAttribute('aria-label')).toBe('For loop body - invalid loop linkage');
    expect(boundary?.getAttribute('data-loop-body-status')).toBe('invalid_linkage');
  });
});
