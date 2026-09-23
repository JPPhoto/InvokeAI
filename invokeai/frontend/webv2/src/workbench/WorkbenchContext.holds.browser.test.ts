import type { AccountScope } from '@platform/state/accountLifecycle';

import { apiFetch } from '@platform/transport/http';
import { expect, it, vi } from 'vitest';

import type { Project } from './projectContracts';
import type { WorkbenchInternalStore } from './workbenchStore';

import { startBrowserIntermediateHold } from './WorkbenchContext';

vi.mock('@platform/transport/http', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  apiFetch: vi.fn().mockResolvedValue(undefined),
}));
it('replaces current holds and releases names removed from the open editor', async () => {
  const fetch = vi.mocked(apiFetch);
  fetch.mockClear();
  let projects = [{ canvas: { imageName: 'first.png' } }] as unknown as Project[];
  let notify: () => void = () => undefined;
  const store = {
    getSnapshot: () => ({ projects }),
    subscribe: (callback: () => void) => {
      notify = callback;
      return () => undefined;
    },
  } as unknown as WorkbenchInternalStore;
  const owner: AccountScope = { accountId: 'alice', epoch: 1, signal: new AbortController().signal, storageSuffix: '' };
  const stop = startBrowserIntermediateHold(store, owner, () => undefined);
  try {
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/holds/'),
        expect.objectContaining({
          body: JSON.stringify({ images: ['first.png'], videos: [] }),
          method: 'PUT',
        })
      )
    );

    projects = [{ canvas: { imageName: 'second.png' } }] as unknown as Project[];
    notify();
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/holds/'),
        expect.objectContaining({
          body: JSON.stringify({ images: ['second.png'], videos: [] }),
          method: 'PUT',
        })
      )
    );

    projects = [];
    notify();
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/holds/'),
        expect.objectContaining({
          method: 'DELETE',
        })
      )
    );
  } finally {
    stop();
  }
});

it('includes names retained by Canvas undo after the current project removes them', async () => {
  const fetch = vi.mocked(apiFetch);
  fetch.mockClear();
  let projects = [{ id: 'project-1', canvas: { imageName: 'first.png' } }] as unknown as Project[];
  let undoNames = ['first.png'];
  let notify: () => void = () => undefined;
  const store = {
    getSnapshot: () => ({ projects }),
    subscribe: (callback: () => void) => {
      notify = callback;
      return () => undefined;
    },
  } as unknown as WorkbenchInternalStore;
  const owner: AccountScope = { accountId: 'alice', epoch: 1, signal: new AbortController().signal, storageSuffix: '' };
  const stop = startBrowserIntermediateHold(store, owner, () => ({ images: undoNames, videos: [] }));
  try {
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    projects = [{ id: 'project-1', canvas: { imageName: 'second.png' } }] as unknown as Project[];
    notify();
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/holds/'),
        expect.objectContaining({ body: JSON.stringify({ images: ['first.png', 'second.png'], videos: [] }) })
      )
    );

    undoNames = [];
    projects = [{ id: 'project-1', canvas: { imageName: 'second.png' } }] as unknown as Project[];
    notify();
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/holds/'),
        expect.objectContaining({ body: JSON.stringify({ images: ['second.png'], videos: [] }) })
      )
    );
  } finally {
    stop();
  }
});

it('keeps old batches held until every replacement batch is installed', async () => {
  const fetch = vi.mocked(apiFetch);
  fetch.mockClear();
  const imageNames = Array.from({ length: 50_001 }, (_, index) => `b${index.toString().padStart(5, '0')}.png`);
  const boundaryName = imageNames[49_999]!;
  let projects = [{ canvas: { images: imageNames.map((imageName) => ({ imageName })) } }] as unknown as Project[];
  let notify: () => void = () => undefined;
  const store = {
    getSnapshot: () => ({ projects }),
    subscribe: (callback: () => void) => {
      notify = callback;
      return () => undefined;
    },
  } as unknown as WorkbenchInternalStore;
  const held = new Map<string, string[]>();
  let started = false;
  let exposed = false;
  let failSecondStagedBatch = true;
  fetch.mockImplementation((url, options) => {
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
  const owner: AccountScope = { accountId: 'alice', epoch: 1, signal: new AbortController().signal, storageSuffix: '' };
  const stop = startBrowserIntermediateHold(store, owner, () => undefined);
  try {
    await vi.waitFor(() => expect(held.size).toBe(2));
    const initialLeases = [...held.keys()];
    started = true;
    projects = [
      { canvas: { images: [{ imageName: 'a.png' }, ...imageNames.map((imageName) => ({ imageName }))] } },
    ] as unknown as Project[];
    notify();
    await vi.waitFor(() => expect(failSecondStagedBatch).toBe(false));
    expect(initialLeases.every((lease) => held.has(lease))).toBe(true);
    projects = [...projects];
    notify();
    await vi.waitFor(() => expect(initialLeases.every((lease) => !held.has(lease))).toBe(true));
    expect(exposed).toBe(false);
  } finally {
    stop();
    fetch.mockResolvedValue(undefined as never);
  }
});
