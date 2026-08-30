import type { PendingConnection } from 'features/nodes/store/types';
import { CONNECTOR_INPUT_HANDLE, CONNECTOR_OUTPUT_HANDLE } from 'features/nodes/store/util/connectorTopology';
import { add, buildEdge, buildNode, for_loop, for_return, templates } from 'features/nodes/store/util/testUtils';
import type { InvocationTemplate } from 'features/nodes/types/invocation';
import { describe, expect, it } from 'vitest';

import { getPendingConnectionNodeItems, sortNodeCommandItemGroups, sortNodeCommandItems } from './AddNodeCmdk';

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

  it('only offers ForReturn for a For loop linkage connection', () => {
    const pendingConnection: PendingConnection = {
      nodeId: 'for-node',
      handleId: 'loop_linkage',
      handleType: 'source' as const,
      fieldTemplate: for_loop.outputs.loop_linkage as PendingConnection['fieldTemplate'],
    };

    const items = getPendingConnectionNodeItems([add, for_return], pendingConnection, '');

    expect(items.map((item) => item.value)).toEqual(['for_return']);
  });

  it('only offers For for a ForReturn loop linkage connection', () => {
    const pendingConnection: PendingConnection = {
      nodeId: 'return-node',
      handleId: 'loop_linkage',
      handleType: 'target' as const,
      fieldTemplate: for_return.inputs.loop_linkage as PendingConnection['fieldTemplate'],
    };

    const items = getPendingConnectionNodeItems([add, for_loop], pendingConnection, '');

    expect(items.map((item) => item.value)).toEqual(['for']);
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
    const addOther = { ...add, title: 'Add Other', type: 'add_other' } as InvocationTemplate;

    const items = getPendingConnectionNodeItems([add, addOther], pendingConnection, 'add');
    const sortedItems = sortNodeCommandItems(items, 'add', pendingConnection);

    expect(sortedItems.map((item) => item.value)).toEqual(['add', 'add_other']);
  });
});

describe('sortNodeCommandItemGroups', () => {
  it('promotes the category containing ForReturn for an iteration output connection', () => {
    const addItem = getPendingConnectionNodeItems(
      [add],
      {
        nodeId: 'add-node',
        handleId: 'value',
        handleType: 'source',
        fieldTemplate: add.outputs.value as PendingConnection['fieldTemplate'],
      },
      ''
    )[0];
    const forReturnItem = getPendingConnectionNodeItems(
      [for_return],
      {
        nodeId: 'for-node',
        handleId: 'item',
        handleType: 'source',
        fieldTemplate: for_loop.outputs.item as PendingConnection['fieldTemplate'],
      },
      ''
    )[0];
    if (!addItem || !forReturnItem) {
      throw new Error('Expected command items');
    }

    const groups = sortNodeCommandItemGroups(
      [
        ['math', [addItem]],
        ['other', [forReturnItem]],
      ],
      '',
      true
    );

    expect(groups.map(([category]) => category)).toEqual(['other', 'math']);
  });
});
