import { accountLifecycle } from '@platform/state/accountLifecycle';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  apiFetchJson: vi.fn(),
}));

vi.mock('@platform/transport/http', () => transport);

import {
  cancelCurrentQueueItem,
  cancelQueueItems,
  cancelScopedQueueItems,
  clearFailedQueueItems,
  clearScopedQueue,
} from './serverApi';

describe('queue command account ownership', () => {
  beforeEach(() => {
    accountLifecycle.activate('user-a');
    transport.apiFetchJson.mockReset();
  });

  it.each([
    {
      name: 'clear failed',
      resolveFirst: { item_ids: [11], limit: 1, offset: 0 },
      run: () => clearFailedQueueItems({ originPrefix: 'webv2:p:a:' }),
    },
    {
      name: 'clear scoped',
      resolveFirst: { item_ids: [11], limit: 1, offset: 0 },
      run: () => clearScopedQueue({ originPrefix: 'webv2:p:a:' }),
    },
    {
      name: 'cancel current',
      resolveFirst: { item_id: 11, status: 'in_progress' },
      run: () => cancelCurrentQueueItem(),
    },
    {
      name: 'cancel scoped',
      resolveFirst: { item_ids: [11], limit: 1, offset: 0 },
      run: () => cancelScopedQueueItems({ originPrefix: 'webv2:p:a:' }),
    },
  ])('does not start the second $name request after an account switch', async ({ resolveFirst, run }) => {
    let resolveRequest: ((value: unknown) => void) | undefined;
    transport.apiFetchJson.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        })
    );

    const oldCommand = run();
    const signal = (transport.apiFetchJson.mock.calls[0]?.[1] as RequestInit | undefined)?.signal;

    accountLifecycle.invalidate();
    accountLifecycle.activate('user-b');
    resolveRequest?.(resolveFirst);

    await expect(oldCommand).rejects.toThrow('no longer active');
    expect(signal?.aborted).toBe(true);
    expect(transport.apiFetchJson).toHaveBeenCalledTimes(1);
  });

  it('bounds fallback item cancellation concurrency', async () => {
    let active = 0;
    let maximum = 0;
    transport.apiFetchJson.mockImplementation(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
      active -= 1;
    });

    await cancelQueueItems(Array.from({ length: 40 }, (_, index) => index + 1));

    expect(transport.apiFetchJson).toHaveBeenCalledTimes(40);
    expect(maximum).toBeLessThanOrEqual(8);
  });
});
