import type { PendingConnection } from 'features/nodes/store/types';
import { add, for_loop, for_return } from 'features/nodes/store/util/testUtils';
import { describe, expect, it } from 'vitest';

import { getPendingConnectionNodeItems } from './AddNodeCmdk';

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
});
