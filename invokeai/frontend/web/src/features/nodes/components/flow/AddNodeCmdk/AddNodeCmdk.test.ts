import type { PendingConnection } from 'features/nodes/store/types';
import { CONNECTOR_INPUT_HANDLE, CONNECTOR_OUTPUT_HANDLE } from 'features/nodes/store/util/connectorTopology';
import { add, buildEdge, buildNode, for_loop, for_return, templates } from 'features/nodes/store/util/testUtils';
import type { InvocationTemplate } from 'features/nodes/types/invocation';
import { describe, expect, it } from 'vitest';

import { getForReturnBodyIdentity, getPendingConnectionNodeItems, sortNodeCommandItems } from './AddNodeCmdk';

describe('getPendingConnectionNodeItems', () => {
  it('prioritizes ForReturn for an iteration output connection', () => {
    const pendingConnection: PendingConnection = {
      nodeId: 'for-node',
      handleId: 'item',
      handleType: 'source' as const,
      fieldTemplate: for_loop.outputs.item as PendingConnection['fieldTemplate'],
    };

    const items = getPendingConnectionNodeItems([add, for_return], pendingConnection, '');

    expect(items[0]?.value).toBe('for_return');
  });

  it('keeps ForReturn first after exact-title search ranking', () => {
    const pendingConnection: PendingConnection = {
      nodeId: 'for-node',
      handleId: 'item',
      handleType: 'source' as const,
      fieldTemplate: for_loop.outputs.item as PendingConnection['fieldTemplate'],
    };

    const items = getPendingConnectionNodeItems([for_loop, for_return], pendingConnection, 'for');

    const sortedItems = sortNodeCommandItems(items, 'for', pendingConnection);

    expect(sortedItems.map((item) => item.value)).toEqual(['for_return', 'for']);
  });

  it('prioritizes ForReturn when the iteration output passes through a connector', () => {
    const forNode = buildNode(for_loop);
    forNode.id = 'for-node';
    const connector = {
      id: 'connector-node',
      type: 'connector' as const,
      position: { x: 0, y: 0 },
      data: { id: 'connector-node', type: 'connector' as const, label: 'Connector', isOpen: true },
    };
    const pendingConnection: PendingConnection = {
      nodeId: connector.id,
      handleId: CONNECTOR_OUTPUT_HANDLE,
      handleType: 'source' as const,
      fieldTemplate: {
        name: CONNECTOR_OUTPUT_HANDLE,
        title: 'Connector Output',
        description: '',
        fieldKind: 'output',
        ui_hidden: false,
        type: { name: 'AnyField', cardinality: 'SINGLE', batch: false },
      },
    };

    const items = getPendingConnectionNodeItems([add, for_return], pendingConnection, '', {
      nodes: [forNode, connector],
      edges: [buildEdge(forNode.id, 'item', connector.id, CONNECTOR_INPUT_HANDLE)],
      templates: { ...templates, for: for_loop, for_return },
    });

    expect(items[0]?.value).toBe('for_return');
  });

  it('preserves generic pending connection ordering for non-loop outputs', () => {
    const pendingConnection: PendingConnection = {
      nodeId: 'add-node',
      handleId: 'value',
      handleType: 'source' as const,
      fieldTemplate: add.outputs.value as PendingConnection['fieldTemplate'],
    };

    const items = getPendingConnectionNodeItems([add, for_return], pendingConnection, '');

    expect(items.map((item) => item.value)).toEqual(['add', 'for_return']);
  });

  it('preserves exact-title ranking for a non-loop pending connection', () => {
    const pendingConnection: PendingConnection = {
      nodeId: 'add-node',
      handleId: 'value',
      handleType: 'source' as const,
      fieldTemplate: add.outputs.value as PendingConnection['fieldTemplate'],
    };
    const forOther = { ...for_loop, title: 'For Other', type: 'for_other' } as InvocationTemplate;

    const items = getPendingConnectionNodeItems([for_loop, forOther], pendingConnection, 'for');
    const sortedItems = sortNodeCommandItems(items, 'for', pendingConnection);

    expect(sortedItems.map((item) => item.value)).toEqual(['for', 'for_other']);
  });
});

describe('getForReturnBodyIdentity', () => {
  const pendingConnection: PendingConnection = {
    nodeId: 'for-node',
    handleId: 'item',
    handleType: 'source' as const,
    fieldTemplate: for_loop.outputs.item as PendingConnection['fieldTemplate'],
  };

  it('reuses an existing For body identity', () => {
    const forNode = buildNode(for_loop);
    forNode.id = pendingConnection.nodeId;
    const bodyIdInput = forNode.data.inputs.body_id;
    if (!bodyIdInput) {
      throw new Error('Expected For body identity input');
    }
    bodyIdInput.value = 'body-1';

    expect(getForReturnBodyIdentity(pendingConnection, [forNode])).toEqual({
      sourceNodeId: 'for-node',
      bodyId: 'body-1',
    });
  });

  it('creates a body identity for an editor-created For', () => {
    const forNode = buildNode(for_loop);
    forNode.id = pendingConnection.nodeId;

    const result = getForReturnBodyIdentity(pendingConnection, [forNode]);

    expect(result?.sourceNodeId).toBe('for-node');
    expect(result?.bodyId).toEqual(expect.any(String));
    expect(result?.bodyId).not.toBe('');
  });

  it('ignores non-For iteration sources', () => {
    const sourceNode = buildNode(add);
    sourceNode.id = pendingConnection.nodeId;

    expect(getForReturnBodyIdentity(pendingConnection, [sourceNode])).toBeNull();
  });

  it('resolves a For iteration source through a connector', () => {
    const forNode = buildNode(for_loop);
    forNode.id = 'for-node';
    const connector = {
      id: 'connector-node',
      type: 'connector' as const,
      position: { x: 0, y: 0 },
      data: { id: 'connector-node', type: 'connector' as const, label: 'Connector', isOpen: true },
    };
    const connectorPendingConnection: PendingConnection = {
      nodeId: connector.id,
      handleId: CONNECTOR_OUTPUT_HANDLE,
      handleType: 'source' as const,
      fieldTemplate: {
        name: CONNECTOR_OUTPUT_HANDLE,
        title: 'Connector Output',
        description: '',
        fieldKind: 'output',
        ui_hidden: false,
        type: { name: 'AnyField', cardinality: 'SINGLE', batch: false },
      },
    };

    const result = getForReturnBodyIdentity(
      connectorPendingConnection,
      [forNode, connector],
      [buildEdge(forNode.id, 'item', connector.id, CONNECTOR_INPUT_HANDLE)],
      { for: for_loop }
    );

    expect(result?.sourceNodeId).toBe(forNode.id);
    expect(result?.bodyId).toEqual(expect.any(String));
  });
});
