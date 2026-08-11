import type { PendingConnection } from 'features/nodes/store/types';
import type { InvocationTemplate } from 'features/nodes/types/invocation';
import { add, for_loop, for_return } from 'features/nodes/store/util/testUtils';
import { describe, expect, it } from 'vitest';

import { getPendingConnectionNodeItems, sortNodeCommandItems } from './AddNodeCmdk';

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
