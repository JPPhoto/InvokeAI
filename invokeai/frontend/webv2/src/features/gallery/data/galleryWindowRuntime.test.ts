import type { GalleryItem, GalleryItemsPage } from '@features/gallery/core/items';
import type { GalleryItemsFilter } from '@features/gallery/data/queries';

import { accountLifecycle } from '@platform/state/accountLifecycle';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  fetchImageIndexAvailability: vi.fn(),
  hydrateGalleryDateBoardItemPage: vi.fn(),
  isDateBoardId: vi.fn(),
  listGalleryBoards: vi.fn(),
  listGalleryDateBoardItemNames: vi.fn(),
  listGalleryDateBoards: vi.fn(),
  listGalleryItemNames: vi.fn(),
  listGalleryItems: vi.fn(),
  listPaletteImages: vi.fn(),
  listSemanticGalleryItemNames: vi.fn(),
}));

vi.mock('./backend', () => backend);

import { createGalleryWindowRuntime } from './queryCache';

const filter: GalleryItemsFilter = {
  boardId: 'board-1',
  galleryView: 'images',
  orderDir: 'DESC',
  searchTerm: '',
};

const createPage = (offset: number, total = 2_000, limit = 60): GalleryItemsPage => ({
  items: Array.from({ length: Math.min(limit, Math.max(0, total - offset)) }, (_, index) => {
    const absoluteIndex = offset + index;
    return {
      boardId: 'board-1',
      category: 'general',
      createdAt: new Date(absoluteIndex * 1_000).toISOString(),
      fullUrl: `/images/${absoluteIndex}`,
      height: 64,
      isIntermediate: false,
      kind: 'image',
      name: `image-${absoluteIndex}`,
      starred: false,
      thumbnailUrl: `/images/${absoluteIndex}/thumbnail`,
      width: 64,
    } satisfies GalleryItem;
  }),
  total,
});

const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for gallery window runtime.');
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
};

describe('gallery window runtime', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    accountLifecycle.activate('gallery-window-runtime-test');
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    backend.fetchImageIndexAvailability.mockReset();
    backend.hydrateGalleryDateBoardItemPage.mockReset();
    backend.isDateBoardId.mockReset().mockReturnValue(false);
    backend.listGalleryBoards.mockReset();
    backend.listGalleryDateBoardItemNames.mockReset();
    backend.listGalleryDateBoards.mockReset();
    backend.listGalleryItemNames.mockReset();
    backend.listGalleryItems
      .mockReset()
      .mockImplementation(({ offset }: { offset: number }) => Promise.resolve(createPage(offset)));
    backend.listPaletteImages.mockReset();
    backend.listSemanticGalleryItemNames.mockReset();
  });

  afterEach(() => queryClient.clear());

  it('re-anchors a distant jump, then serializes to the latest requested range', async () => {
    const deferredPage = { resolve: (_page: GalleryItemsPage): void => undefined };
    backend.listGalleryItems.mockImplementation(({ offset }: { offset: number }) => {
      if (offset === 60) {
        return new Promise<GalleryItemsPage>((resolve) => {
          deferredPage.resolve = (page) => {
            resolve(page);
          };
        });
      }
      return Promise.resolve(createPage(offset));
    });

    const runtime = createGalleryWindowRuntime({
      consumerId: 'grid',
      filter,
      initialOffset: 0,
      isPaginated: false,
      queryClient,
    });
    const unsubscribe = runtime.subscribe(() => undefined);
    try {
      await waitFor(() => backend.listGalleryItems.mock.calls.some(([request]) => request.offset === 0));
      await waitFor(() => runtime.getSnapshot().result.isSuccess);

      runtime.loadRange(60, 70);
      await waitFor(() => backend.listGalleryItems.mock.calls.some(([request]) => request.offset === 60));
      runtime.loadRange(900, 910);
      deferredPage.resolve(createPage(60));

      await waitFor(() => backend.listGalleryItems.mock.calls.some(([request]) => request.offset === 900));
      await waitFor(() => runtime.getSnapshot().offset === 900 && runtime.getSnapshot().result.isSuccess);
      expect(backend.listGalleryItems.mock.calls.map(([request]) => request.offset)).toEqual([0, 60, 900]);
    } finally {
      unsubscribe();
    }
  });

  it('preserves listing geometry while a distant page loads or fails', async () => {
    let rejectPage: (error: Error) => void = () => undefined;
    backend.listGalleryItems.mockImplementation(({ offset }: { offset: number }) => {
      if (offset === 900) {
        return new Promise<GalleryItemsPage>((_resolve, reject) => {
          rejectPage = reject;
        });
      }
      return Promise.resolve(createPage(offset));
    });
    const runtime = createGalleryWindowRuntime({
      consumerId: 'stable-geometry',
      filter,
      initialOffset: 0,
      isPaginated: false,
      queryClient,
    });
    const unsubscribe = runtime.subscribe(() => undefined);
    try {
      await waitFor(() => runtime.getSnapshot().result.isSuccess);
      runtime.loadRange(900, 910);
      await waitFor(() => backend.listGalleryItems.mock.calls.some(([request]) => request.offset === 900));
      expect(runtime.getSnapshot().result.data).toBeUndefined();
      expect(runtime.getSnapshot().total).toBe(2000);
      rejectPage(new Error('Unavailable'));
      await waitFor(() => runtime.getSnapshot().result.isError);
      expect(runtime.getSnapshot().total).toBe(2000);
      backend.listGalleryItems.mockImplementation(({ offset }: { offset: number }) =>
        Promise.resolve(createPage(offset))
      );
      runtime.retry();
      await waitFor(() => runtime.getSnapshot().result.isSuccess);
      expect(runtime.getSnapshot().result.data?.pageParams).toEqual([900]);
      expect(runtime.getSnapshot().total).toBe(2000);
    } finally {
      unsubscribe();
    }
  });

  it('reloads the original anchor after forward eviction and releases the old window', async () => {
    const runtime = createGalleryWindowRuntime({
      consumerId: 'return-to-top',
      filter,
      initialOffset: 0,
      isPaginated: false,
      queryClient,
    });
    const unsubscribe = runtime.subscribe(() => undefined);
    try {
      await waitFor(() => runtime.getSnapshot().result.isSuccess);
      for (let page = 1; page <= 12; page += 1) {
        runtime.loadRange(page * 60, page * 60 + 10);
        await waitFor(() => Boolean(runtime.getSnapshot().result.data?.pageParams.includes(page * 60)));
      }
      expect(runtime.getSnapshot().result.data?.pages).toHaveLength(10);
      expect(runtime.getSnapshot().offset).toBe(180);
      runtime.loadRange(0, 10);
      await waitFor(() => runtime.getSnapshot().offset === 0 && runtime.getSnapshot().result.isSuccess);
      expect(runtime.getSnapshot().result.data?.pages[0]?.items[0]?.name).toBe('image-0');
      expect(backend.listGalleryItems.mock.calls.at(-1)?.[0].offset).toBe(0);
      await waitFor(() => queryClient.getQueryCache().getAll().length === 1);
      expect(queryClient.getQueryCache().getAll()[0]?.state.data).toBe(runtime.getSnapshot().result.data);
    } finally {
      unsubscribe();
    }
  });

  it('retries a failed direction only after an explicit retry request', async () => {
    let failed = false;
    backend.listGalleryItems.mockImplementation(({ offset }: { offset: number }) => {
      if (offset === 60 && !failed) {
        failed = true;
        return Promise.reject(new Error('temporary page failure'));
      }
      return Promise.resolve(createPage(offset));
    });
    const runtime = createGalleryWindowRuntime({
      consumerId: 'picker',
      filter,
      initialOffset: 0,
      isPaginated: false,
      queryClient,
    });
    const unsubscribe = runtime.subscribe(() => undefined);
    try {
      await waitFor(() => runtime.getSnapshot().result.isSuccess);
      runtime.loadRange(60, 70);
      await waitFor(() => runtime.getSnapshot().result.isError);
      expect(backend.listGalleryItems.mock.calls.filter(([request]) => request.offset === 60)).toHaveLength(1);

      runtime.retry();
      await waitFor(() =>
        Boolean(runtime.getSnapshot().result.isSuccess && runtime.getSnapshot().result.data?.pageParams.includes(60))
      );
      expect(backend.listGalleryItems.mock.calls.filter(([request]) => request.offset === 60)).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });

  it('rebuilds the retained span when the backend total changes between adjacent pages', async () => {
    let initialPage = true;
    backend.listGalleryItems.mockImplementation(({ limit, offset }: { limit: number; offset: number }) => {
      if (offset === 0 && initialPage) {
        initialPage = false;
        return Promise.resolve(createPage(offset, 2_000));
      }
      return Promise.resolve(createPage(offset, 2_001, limit));
    });
    const runtime = createGalleryWindowRuntime({
      consumerId: 'changing-total',
      filter,
      initialOffset: 0,
      isPaginated: false,
      queryClient,
    });
    const unsubscribe = runtime.subscribe(() => undefined);
    try {
      await waitFor(() => runtime.getSnapshot().result.isSuccess);
      runtime.loadRange(60, 70);
      await waitFor(() =>
        Boolean(
          runtime.getSnapshot().result.data?.pages.length === 2 &&
          runtime.getSnapshot().result.data?.pages.every((page) => page.total === 2_001)
        )
      );
      expect(runtime.getSnapshot().result.data?.pages[1]?.items[0]?.name).toBe('image-60');
      expect(backend.listGalleryItems.mock.calls.map(([request]) => request.offset)).toEqual([0, 60, 0]);
    } finally {
      unsubscribe();
    }
  });

  it('rebuilds again when the same page-total mismatch recurs after a successful repair', async () => {
    backend.listGalleryItems.mockImplementation(({ limit, offset }: { limit: number; offset: number }) =>
      Promise.resolve(createPage(offset, limit === 60 && offset > 0 ? 2_000 : 2_001, limit))
    );
    const runtime = createGalleryWindowRuntime({
      consumerId: 'recurring-total-mismatch',
      filter,
      initialOffset: 0,
      isPaginated: false,
      queryClient,
    });
    const unsubscribe = runtime.subscribe(() => undefined);
    try {
      await waitFor(() => runtime.getSnapshot().result.isSuccess);
      for (const offset of [60, 120]) {
        runtime.loadRange(offset, offset + 10);
        await waitFor(() => {
          const data = runtime.getSnapshot().result.data;
          return Boolean(data?.pageParams.includes(offset) && data.pages.every((page) => page.total === 2_001));
        });
      }

      expect(runtime.getSnapshot().total).toBe(2_001);
      expect(runtime.getSnapshot().result.data?.pageParams).toEqual([0, 60, 120]);
      expect(
        backend.listGalleryItems.mock.calls.filter(([request]) => request.limit > 60).map(([request]) => request.limit)
      ).toEqual([120, 180]);
    } finally {
      unsubscribe();
    }
  });

  it('does not repeatedly refetch an unchanged mismatch when the span rebuild falls back', async () => {
    let boundaryReads = 0;
    backend.listGalleryItems.mockImplementation(({ limit, offset }: { limit: number; offset: number }) => {
      if (offset === 60 && limit === 60 && ++boundaryReads > 2) {
        return Promise.reject(new Error('Unexpected repeated boundary fetch'));
      }
      // An incomplete span cannot replace the retained window, so invalidation collapses and refetches it.
      return Promise.resolve(createPage(offset, offset === 60 ? 2_000 : 2_001));
    });
    const runtime = createGalleryWindowRuntime({
      consumerId: 'unrepaired-total-mismatch',
      filter,
      initialOffset: 0,
      isPaginated: false,
      queryClient,
    });
    const unsubscribe = runtime.subscribe(() => undefined);
    try {
      await waitFor(() => runtime.getSnapshot().result.isSuccess);
      runtime.loadRange(60, 70);
      await waitFor(() => {
        const { result } = runtime.getSnapshot();
        return result.isError || (boundaryReads === 2 && result.data?.pages.length === 2 && !result.isFetching);
      });

      expect(runtime.getSnapshot().result.isError).toBe(false);
      expect(boundaryReads).toBe(2);
      expect(backend.listGalleryItems.mock.calls.filter(([request]) => request.limit > 60)).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it('retains a viewport-derived window when the visible range exceeds ten pages', async () => {
    const runtime = createGalleryWindowRuntime({
      consumerId: 'wide-grid',
      filter,
      initialOffset: 0,
      isPaginated: false,
      queryClient,
    });
    const unsubscribe = runtime.subscribe(() => undefined);
    try {
      await waitFor(() => runtime.getSnapshot().result.isSuccess);
      runtime.loadRange(0, 720);
      await waitFor(() => Boolean(runtime.getSnapshot().result.data?.pageParams.includes(720)));

      expect(runtime.getSnapshot().result.data?.pageParams).toEqual(
        Array.from({ length: 13 }, (_, index) => index * 60)
      );
      expect(backend.listGalleryItems.mock.calls.map(([request]) => request.offset)).toEqual(
        Array.from({ length: 13 }, (_, index) => index * 60)
      );

      runtime.loadRange(0, 10);
      await waitFor(() => runtime.getSnapshot().result.data?.pages.length === 10);
      expect(runtime.getSnapshot().result.data?.pageParams).toEqual(
        Array.from({ length: 10 }, (_, index) => index * 60)
      );
    } finally {
      unsubscribe();
    }
  });

  it('fences an old account while a page request settles and keeps the new account window separate', async () => {
    let finishOldPage: ((page: GalleryItemsPage) => void) | undefined;
    backend.listGalleryItems.mockImplementation(({ offset }: { offset: number }) =>
      offset === 60
        ? new Promise<GalleryItemsPage>((resolve) => {
            finishOldPage = resolve;
          })
        : Promise.resolve(createPage(offset))
    );
    const oldRuntime = createGalleryWindowRuntime({
      consumerId: 'same-placement',
      filter,
      initialOffset: 0,
      isPaginated: false,
      queryClient,
    });
    const stopOld = oldRuntime.subscribe(() => undefined);
    let stopNew: (() => void) | undefined;
    try {
      await waitFor(() => oldRuntime.getSnapshot().result.isSuccess);
      oldRuntime.loadRange(60, 130);
      await waitFor(() => finishOldPage !== undefined);
      accountLifecycle.activate('different-account');
      oldRuntime.loadRange(900, 910);
      oldRuntime.retry();
      const newRuntime = createGalleryWindowRuntime({
        consumerId: 'same-placement',
        filter,
        initialOffset: 0,
        isPaginated: false,
        queryClient,
      });
      stopNew = newRuntime.subscribe(() => undefined);
      await waitFor(() => newRuntime.getSnapshot().result.isSuccess);
      finishOldPage?.(createPage(60));
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(backend.listGalleryItems.mock.calls.map(([request]) => request.offset)).toEqual([0, 60, 0]);
      expect(newRuntime.getSnapshot().result.data?.pageParams).toEqual([0]);
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey[3])
      ).toEqual([
        expect.objectContaining({ accountId: 'gallery-window-runtime-test' }),
        expect.objectContaining({ accountId: 'different-account' }),
      ]);
    } finally {
      stopOld();
      stopNew?.();
    }
  });

  it('does not continue loading a range after its consumer unsubscribes', async () => {
    const deferredPage = { resolve: (_page: GalleryItemsPage): void => undefined };
    backend.listGalleryItems.mockImplementation(({ offset }: { offset: number }) => {
      if (offset === 60) {
        return new Promise<GalleryItemsPage>((resolve) => {
          deferredPage.resolve = (page) => {
            resolve(page);
          };
        });
      }
      return Promise.resolve(createPage(offset));
    });
    const runtime = createGalleryWindowRuntime({
      consumerId: 'closing-picker',
      filter,
      initialOffset: 0,
      isPaginated: false,
      queryClient,
    });
    const unsubscribe = runtime.subscribe(() => undefined);
    await waitFor(() => runtime.getSnapshot().result.isSuccess);
    runtime.loadRange(60, 130);
    await waitFor(() => backend.listGalleryItems.mock.calls.some(([request]) => request.offset === 60));
    unsubscribe();
    deferredPage.resolve(createPage(60));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(backend.listGalleryItems.mock.calls.map(([request]) => request.offset)).toEqual([0, 60]);
  });

  it('keeps a bounded readable snapshot while paused and restores its observer on resume', async () => {
    const runtime = createGalleryWindowRuntime({
      consumerId: 'keep-alive-resume',
      filter,
      initialOffset: 0,
      isPaginated: false,
      queryClient,
    });
    const pause = runtime.subscribe(() => undefined);
    await waitFor(() => runtime.getSnapshot().result.isSuccess);
    const pausedSnapshot = runtime.getSnapshot();

    pause();

    expect(runtime.getSnapshot()).toBe(pausedSnapshot);
    expect(runtime.getSnapshot().result.data?.pages).toHaveLength(1);
    expect(runtime.getSnapshot().total).toBe(2_000);

    const resume = runtime.subscribe(() => undefined);
    try {
      await waitFor(() => runtime.getSnapshot().result.isSuccess);
      expect(runtime.getSnapshot().result.data?.pages[0]?.items[0]?.name).toBe('image-0');
      expect(runtime.getSnapshot().total).toBe(2_000);
      expect(backend.listGalleryItems.mock.calls.map(([request]) => request.offset)).toEqual([0, 0]);
    } finally {
      resume();
    }
  });
});
