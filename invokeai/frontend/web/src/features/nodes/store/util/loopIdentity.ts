import type { AnyNode, InvocationNode } from 'features/nodes/types/invocation';
import { isInvocationNode } from 'features/nodes/types/invocation';
import { v4 as uuidv4 } from 'uuid';

const isLoopBoundaryNode = (node: AnyNode): node is InvocationNode =>
  isInvocationNode(node) && (node.data.type === 'for' || node.data.type === 'for_return');

export const createLoopBodyIdentity = (): string => uuidv4();

export const getLoopBodyIdentity = (node: AnyNode | undefined): string | undefined => {
  if (!node || !isLoopBoundaryNode(node)) {
    return undefined;
  }

  const bodyId = node.data.inputs.body_id?.value;
  return typeof bodyId === 'string' && bodyId.length > 0 ? bodyId : undefined;
};

const withLoopBodyIdentity = (node: InvocationNode, bodyId: string | undefined): InvocationNode => {
  const bodyIdInput = node.data.inputs.body_id;
  if (!bodyIdInput) {
    return node;
  }

  return {
    ...node,
    data: {
      ...node.data,
      inputs: {
        ...node.data.inputs,
        body_id: { ...bodyIdInput, value: bodyId },
      },
    },
  };
};

type LoopBoundaryGroup = {
  forCount: number;
  forReturnCount: number;
};

export const reassignCopiedLoopBodyIdentities = (nodes: AnyNode[], createBodyId: () => string = uuidv4): AnyNode[] => {
  const groups = new Map<string, LoopBoundaryGroup>();

  for (const node of nodes) {
    const bodyId = getLoopBodyIdentity(node);
    if (!bodyId || !isLoopBoundaryNode(node)) {
      continue;
    }

    const group = groups.get(bodyId) ?? { forCount: 0, forReturnCount: 0 };
    if (node.data.type === 'for') {
      group.forCount += 1;
    } else {
      group.forReturnCount += 1;
    }
    groups.set(bodyId, group);
  }

  const reassignedIds = new Map<string, string>();
  for (const [bodyId, group] of groups) {
    if (group.forCount === 1 && group.forReturnCount === 1) {
      reassignedIds.set(bodyId, createBodyId());
    }
  }

  return nodes.map((node) => {
    if (!isLoopBoundaryNode(node) || !node.data.inputs.body_id) {
      return node;
    }

    const bodyId = getLoopBodyIdentity(node);
    return withLoopBodyIdentity(node, bodyId ? reassignedIds.get(bodyId) : undefined);
  });
};
