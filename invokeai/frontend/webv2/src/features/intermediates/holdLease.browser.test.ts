import type { AccountScope } from '@platform/state/accountLifecycle';

import { apiFetch } from '@platform/transport/http';
import { afterEach, expect, it, vi } from 'vitest';

import type { HeldMediaNames } from './holdLease';

import { MAX_HOLD_NAMES_PER_KIND, partitionHeldMediaNames, startIntermediatesHoldLease } from './holdLease';

vi.mock('@platform/transport/http', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  apiFetch: vi.fn().mockResolvedValue(undefined),
  getHttpAuthToken: vi.fn(() => 'lease-token'),
}));

const fetchMock = vi.mocked(apiFetch);

const ownerWith = (signal: AbortSignal): AccountScope => ({ accountId: 'alice', epoch: 1, signal, storageSuffix: '' });

const startWith = (initial: HeldMediaNames, signal = new AbortController().signal) => {
  let held = initial;
  let notify: () => void = () => undefined;
  const stop = startIntermediatesHoldLease({
    owner: ownerWith(signal),
    read: () => held,
    subscribe: (onChange) => {
      notify = onChange;
      return () => undefined;
    },
  });
  return {
    stop,
    update: (next: HeldMediaNames) => {
      held = next;
      notify();
    },
  };
};

const calls = (method: string) =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === method).map(([url, init]) => ({ init, url: String(url) }));

const settle = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 20);
  });

afterEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(undefined as never);
});

it('partitions a long hold without dropping names or exceeding either API limit', () => {
  const images = Array.from({ length: MAX_HOLD_NAMES_PER_KIND + 1 }, (_, index) => `image-${index}`);
  const videos = ['first.mp4', 'second.mp4'];
  const batches = partitionHeldMediaNames(images, videos);

  expect(batches).toHaveLength(2);
  expect(batches.every((batch) => batch.images.length <= 50_000 && batch.videos.length <= 50_000)).toBe(true);
  expect(batches.flatMap((batch) => batch.images)).toEqual(images);
  expect(batches.flatMap((batch) => batch.videos)).toEqual(videos);
});

it('replaces current holds and releases names removed from the open editor', async () => {
  const lease = startWith({ images: ['first.png'], videos: [] });
  try {
    await vi.waitFor(() =>
      expect(calls('PUT').map(({ init }) => init?.body)).toContain(
        JSON.stringify({ images: ['first.png'], videos: [] })
      )
    );
    lease.update({ images: ['second.png'], videos: [] });
    await vi.waitFor(() =>
      expect(calls('PUT').map(({ init }) => init?.body)).toContain(
        JSON.stringify({ images: ['second.png'], videos: [] })
      )
    );
    await vi.waitFor(() => expect(calls('DELETE')).toHaveLength(1));
    lease.update({ images: [], videos: [] });
    await vi.waitFor(() => expect(calls('DELETE')).toHaveLength(2));
  } finally {
    lease.stop();
  }
});

it('releases its leases with keepalive when disposed', async () => {
  const lease = startWith({ images: ['held.png'], videos: ['held.mp4'] });
  await vi.waitFor(() => expect(calls('PUT')).toHaveLength(1));
  const leaseUrl = calls('PUT')[0]!.url;

  lease.stop();

  expect(calls('DELETE')).toEqual([expect.objectContaining({ url: leaseUrl })]);
  expect(calls('DELETE')[0]!.init).toMatchObject({ keepalive: true });
});

it('releases as the account that took the lease after that account signed out', async () => {
  const session = new AbortController();
  const lease = startWith({ images: ['held.png'], videos: [] }, session.signal);
  await vi.waitFor(() => expect(calls('PUT')).toHaveLength(1));

  session.abort();
  lease.stop();

  const [release] = calls('DELETE');
  expect(release).toBeDefined();
  expect(release!.init?.signal).toBeUndefined();
  expect(new Headers(release!.init?.headers).get('Authorization')).toBe('Bearer lease-token');
});

it('releases on pagehide and holds again when the page is restored', async () => {
  const lease = startWith({ images: ['held.png'], videos: [] });
  try {
    await vi.waitFor(() => expect(calls('PUT')).toHaveLength(1));

    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    expect(calls('DELETE')).toHaveLength(1);
    expect(calls('DELETE')[0]!.init).toMatchObject({ keepalive: true });

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await vi.waitFor(() => expect(calls('PUT')).toHaveLength(2));
  } finally {
    lease.stop();
  }
});

it('does not resend an unchanged hold each time the tab becomes visible', async () => {
  const lease = startWith({ images: ['held.png'], videos: [] });
  try {
    await vi.waitFor(() => expect(calls('PUT')).toHaveLength(1));
    await settle();
    expect(document.visibilityState).toBe('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(calls('PUT')).toHaveLength(1);
  } finally {
    lease.stop();
  }
});

it('keeps old batches held until every replacement batch is installed', async () => {
  const imageNames = Array.from({ length: 50_001 }, (_, index) => `b${index.toString().padStart(5, '0')}.png`);
  const boundaryName = imageNames[49_999]!;
  const held = new Map<string, string[]>();
  let started = false;
  let exposed = false;
  let failSecondStagedBatch = true;
  fetchMock.mockImplementation((url, options) => {
    if (started && options?.method === 'PUT' && String(url).endsWith('-1-1') && failSecondStagedBatch) {
      failSecondStagedBatch = false;
      throw new Error('temporary network failure');
    }
    if (options?.method === 'PUT') {
      held.set(String(url), (JSON.parse(String(options.body)) as { images: string[] }).images);
    } else if (options?.method === 'DELETE') {
      held.delete(String(url));
    }
    if (started) {
      exposed ||= ![...held.values()].some((names) => names.includes(boundaryName));
    }
    return Promise.resolve(undefined as never);
  });
  const lease = startWith({ images: imageNames, videos: [] });
  try {
    await vi.waitFor(() => expect(held.size).toBe(2));
    const initialLeases = [...held.keys()];
    started = true;
    lease.update({ images: ['a.png', ...imageNames], videos: [] });
    await vi.waitFor(() => expect(failSecondStagedBatch).toBe(false));
    expect(initialLeases.every((leaseUrl) => held.has(leaseUrl))).toBe(true);
    lease.update({ images: ['a.png', ...imageNames], videos: [] });
    await vi.waitFor(() => expect(initialLeases.every((leaseUrl) => !held.has(leaseUrl))).toBe(true));
    expect(exposed).toBe(false);
  } finally {
    lease.stop();
  }
});
