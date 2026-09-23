import type { ConnectionListener } from '@platform/transport/socketHub';
import type { BackendConnectionStatus } from '@platform/transport/types';

import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';

const hub = vi.hoisted(() => ({
  connection: null as ConnectionListener | null,
  status: 'connected' as BackendConnectionStatus,
}));

vi.mock('@platform/transport/socketHub', () => ({
  socketHub: {
    on: () => () => undefined,
    onConnectionChange: (listener: ConnectionListener) => {
      hub.connection = listener;
      listener(hub.status);
      return () => {
        hub.connection = null;
      };
    },
  },
}));

const { attachIntermediatesRealtime } = await import('./realtime');

afterEach(() => {
  hub.status = 'connected';
});

it('does not refetch on open when the socket is already connected, but does after a reconnect', () => {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const detach = attachIntermediatesRealtime(queryClient);

  expect(invalidate).not.toHaveBeenCalled();
  hub.connection!('disconnected');
  hub.connection!('connected');
  expect(invalidate).toHaveBeenCalledOnce();
  detach();
});

it('refetches once the socket connects after opening while disconnected', () => {
  hub.status = 'disconnected';
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const detach = attachIntermediatesRealtime(queryClient);

  hub.connection!('connected');
  expect(invalidate).toHaveBeenCalledOnce();
  detach();
});
