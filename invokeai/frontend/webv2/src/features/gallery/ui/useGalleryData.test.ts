import type { GalleryItem } from '@features/gallery/core/items';
import type { GalleryImage, GeneratedImageContract } from '@features/gallery/core/types';

import { getBoundedRecentImages } from '@features/gallery/core/recentImages';
import { describe, expect, it } from 'vitest';

import { indexGalleryWindowPages, indexGalleryWindowWithRecentOverlay, mergeGalleryItemWindow } from './useGalleryData';

const createImage = (index: number, overrides: Partial<GalleryImage> = {}): GalleryImage => ({
  boardId: 'none',
  height: 512,
  imageCategory: 'general',
  imageName: `image-${String(index).padStart(4, '0')}.png`,
  imageUrl: `/images/${index}`,
  queuedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  sourceQueueItemId: `queue-${index}`,
  starred: false,
  thumbnailUrl: `/thumbnails/${index}`,
  width: 512,
  ...overrides,
});

const asGenerated = (image: GalleryImage): GeneratedImageContract => image;

const filter = {
  boardId: 'none',
  galleryView: 'images' as const,
  orderDir: 'DESC' as const,
  searchTerm: '',
};

const createBackendItem = (name: string, createdAt: string): GalleryItem => ({
  boardId: 'none',
  category: 'general',
  createdAt,
  fullUrl: `/images/${name}`,
  height: 512,
  isIntermediate: false,
  kind: 'image',
  name,
  starred: false,
  thumbnailUrl: `/thumbnails/${name}`,
  width: 512,
});

describe('indexGalleryWindowPages', () => {
  it('preserves absolute page positions when a cached page is short', () => {
    const indexedItems = indexGalleryWindowPages([
      { offset: 0, items: [createBackendItem('a', '2026-01-01'), createBackendItem('b', '2026-01-02')] },
      { offset: 60, items: [createBackendItem('c', '2026-01-03')] },
    ]);

    expect([...indexedItems.entries()].map(([index, value]) => [index, value.name])).toEqual([
      [0, 'a'],
      [1, 'b'],
      [60, 'c'],
    ]);
    expect(indexedItems.has(2)).toBe(false);
  });

  it('preserves absolute row indices when hydration omits missing refs inside a page', () => {
    const indexedItems = indexGalleryWindowPages([
      {
        offset: 60,
        items: [createBackendItem('a', '2026-01-01'), createBackendItem('c', '2026-01-03')],
        itemIndices: [60, 62],
      },
    ]);

    expect([...indexedItems.entries()].map(([index, item]) => [index, item.name])).toEqual([
      [60, 'a'],
      [62, 'c'],
    ]);
    expect(indexedItems.has(61)).toBe(false);
  });

  it('shifts sparse backend indices without compacting rows when newest local images are prepended', () => {
    const indexedItems = indexGalleryWindowPages(
      [
        {
          offset: 0,
          items: [createBackendItem('a', '2026-01-01'), createBackendItem('c', '2026-01-03')],
          itemIndices: [0, 2],
        },
        { offset: 60, items: [createBackendItem('d', '2026-01-04')] },
      ],
      2
    );

    expect([...indexedItems.entries()].map(([index, item]) => [index, item.name])).toEqual([
      [2, 'a'],
      [4, 'c'],
      [62, 'd'],
    ]);
    expect(indexedItems.has(3)).toBe(false);
  });
});

describe('indexGalleryWindowWithRecentOverlay', () => {
  it('prepends newest-first recents while keeping backend selection pages unshifted', () => {
    const first = createBackendItem('first', '2026-01-01');
    const lastOfPage = createBackendItem('last-of-page', '2026-01-02');
    const recent = createBackendItem('recent', '2026-01-03');
    const result = indexGalleryWindowWithRecentOverlay({
      backendTotal: 120,
      orderDir: 'DESC',
      pages: [{ offset: 0, itemIndices: [0, 59], items: [first, lastOfPage] }],
      recentItems: [recent],
    });

    expect([...result.itemsByIndex.entries()].map(([index, item]) => [index, item.name])).toEqual([
      [0, 'recent'],
      [1, 'first'],
      [60, 'last-of-page'],
    ]);
    expect(result.selectionPageByItemKey.get('image:last-of-page')).toBe(0);
  });

  it('places oldest-first recents after a retained prefix while its next page is unknown', () => {
    const first = createBackendItem('first', '2026-01-01');
    const recent = createBackendItem('recent', '2026-01-03');
    const result = indexGalleryWindowWithRecentOverlay({
      backendTotal: 120,
      orderDir: 'ASC',
      pages: [{ offset: 0, items: [first] }],
      recentItems: [recent],
    });

    expect([...result.itemsByIndex.entries()].map(([index, item]) => [index, item.name])).toEqual([
      [0, 'first'],
      [1, 'recent'],
    ]);
    expect(result.selectionPageByItemKey.get('image:first')).toBe(0);
    expect(result.selectionPageByItemKey.get('image:recent')).toBe(0);
  });

  it('maps an appended oldest-first recent to the last backend page at exact page boundaries', () => {
    const backendItems = Array.from({ length: 60 }, (_, index) => createBackendItem(`backend-${index}`, '2026-01-01'));
    const recent = createBackendItem('recent', '2026-01-03');
    const result = indexGalleryWindowWithRecentOverlay({
      backendTotal: 60,
      orderDir: 'ASC',
      pages: [{ offset: 0, items: backendItems }],
      recentItems: [recent],
    });

    expect(result.itemsByIndex.get(60)?.name).toBe('recent');
    expect(result.selectionPageByItemKey.get('image:recent')).toBe(0);
  });

  it.each([
    { orderDir: 'DESC' as const, recentDate: '2026-01-03', first: 'newer', second: 'older' },
    { orderDir: 'ASC' as const, recentDate: '2026-01-02', first: 'older', second: 'newer' },
  ])('inserts a recent between sparse $orderDir backend indices by its timestamp', (scenario) => {
    const older = createBackendItem('older', '2026-01-01');
    const newer = createBackendItem('newer', '2026-01-04');
    const recent = createBackendItem('recent', scenario.recentDate);
    const pages = [
      {
        offset: 20,
        itemIndices: [20, 22],
        items: scenario.orderDir === 'DESC' ? [newer, older] : [older, newer],
      },
    ];
    const result = indexGalleryWindowWithRecentOverlay({
      backendTotal: 60,
      orderDir: scenario.orderDir,
      pages,
      recentItems: [recent],
    });

    expect(result.itemsByIndex.get(20)?.name).toBe(scenario.first);
    expect(result.itemsByIndex.get(22)?.name).toBe('recent');
    expect(result.itemsByIndex.get(23)?.name).toBe(scenario.second);
    expect(result.backendIndexByItemKey.get(`image:${scenario.first}`)).toBe(20);
    expect(result.selectionPageByItemKey.get(`image:${scenario.second}`)).toBe(0);
  });

  it('keeps a confirmed insertion rank when its page leaves the retained window', () => {
    const newest = createBackendItem('newest', '2026-01-03');
    const oldest = createBackendItem('oldest', '2026-01-01');
    const recent = createBackendItem('recent', '2026-01-02');
    const firstWindow = indexGalleryWindowWithRecentOverlay({
      backendTotal: 120,
      orderDir: 'DESC',
      pages: [{ offset: 0, items: [newest, oldest] }],
      recentItems: [recent],
    });
    const reloadedWindow = indexGalleryWindowWithRecentOverlay({
      backendTotal: 120,
      knownRecentPositions: firstWindow.confirmedRecentPositions,
      orderDir: 'DESC',
      pages: [{ offset: 60, items: [createBackendItem('later-page', '2025-12-01')] }],
      recentItems: [recent],
    });

    expect(firstWindow.confirmedRecentPositions.get('image:recent')).toBe(1);
    expect(reloadedWindow.itemsByIndex.get(1)?.name).toBe('recent');
    expect(reloadedWindow.itemsByIndex.get(61)?.name).toBe('later-page');
  });

  it('rebases a confirmed insertion rank after the listing changes', () => {
    const newest = createBackendItem('newest', '2026-01-03');
    const oldest = createBackendItem('oldest', '2026-01-01');
    const recent = createBackendItem('recent', '2026-01-02');
    const firstWindow = indexGalleryWindowWithRecentOverlay({
      backendTotal: 120,
      orderDir: 'DESC',
      pages: [{ offset: 0, items: [newest, oldest] }],
      recentItems: [recent],
    });
    const updatedWindow = indexGalleryWindowWithRecentOverlay({
      backendTotal: 121,
      knownRecentPositions: firstWindow.confirmedRecentPositions,
      orderDir: 'DESC',
      pages: [{ offset: 0, items: [createBackendItem('new-item', '2026-01-04'), newest, oldest] }],
      recentItems: [recent],
    });

    expect(firstWindow.confirmedRecentPositions.get('image:recent')).toBe(1);
    expect(updatedWindow.confirmedRecentPositions.get('image:recent')).toBe(2);
    expect(updatedWindow.itemsByIndex.get(2)?.name).toBe('recent');
    expect(updatedWindow.itemsByIndex.get(3)?.name).toBe('oldest');
  });

  it('clamps a persisted insertion rank when deletions shorten the listing', () => {
    const recent = createBackendItem('recent', '2026-01-01');
    const remainingItems = Array.from({ length: 10 }, (_, index) =>
      createBackendItem(`remaining-${index}`, `2026-01-${String(20 - index).padStart(2, '0')}`)
    );
    const result = indexGalleryWindowWithRecentOverlay({
      backendTotal: remainingItems.length,
      knownRecentPositions: new Map([['image:recent', 60]]),
      orderDir: 'DESC',
      pages: [{ offset: 0, items: remainingItems }],
      recentItems: [recent],
    });

    expect(result.confirmedRecentPositions.get('image:recent')).toBe(10);
    expect(result.itemsByIndex.get(10)?.name).toBe('recent');
    expect(result.itemsByIndex.has(60)).toBe(false);
  });

  it.each([
    { orderDir: 'DESC' as const, recentDate: '2026-07-31', expectedIndex: 0, emptyExpectedIndex: 0 },
    { orderDir: 'DESC' as const, recentDate: '2026-07-29', expectedIndex: 1200, emptyExpectedIndex: 0 },
    { orderDir: 'ASC' as const, recentDate: '2026-07-29', expectedIndex: 0, emptyExpectedIndex: 1200 },
    { orderDir: 'ASC' as const, recentDate: '2026-07-31', expectedIndex: 1200, emptyExpectedIndex: 1200 },
  ])('uses absolute listing boundaries for $orderDir overlays outside a deep window', (scenario) => {
    const backend = createBackendItem('deep', '2026-07-30');
    const recent = createBackendItem('recent', scenario.recentDate);
    const deepWindow = indexGalleryWindowWithRecentOverlay({
      backendTotal: 1200,
      fallbackInsertionIndex: 600,
      orderDir: scenario.orderDir,
      pages: [{ offset: 600, items: [backend] }],
      recentItems: [recent],
    });
    const emptyReanchor = indexGalleryWindowWithRecentOverlay({
      backendTotal: 1200,
      fallbackInsertionIndex: 600,
      orderDir: scenario.orderDir,
      pages: [],
      recentItems: [recent],
    });

    expect(deepWindow.itemsByIndex.get(scenario.expectedIndex)?.name).toBe('recent');
    expect(emptyReanchor.itemsByIndex.get(scenario.emptyExpectedIndex)?.name).toBe('recent');
  });
});

describe('mergeGalleryItemWindow', () => {
  it('deduplicates by qualified key and mirrors server time/kind/name ordering', () => {
    const image = {
      boardId: 'none',
      category: 'general',
      createdAt: '2026-07-30T12:00:00.000Z',
      fullUrl: '/images/shared',
      height: 64,
      isIntermediate: false,
      kind: 'image',
      name: 'shared',
      starred: false,
      thumbnailUrl: '/thumbnails/shared',
      width: 64,
    } satisfies GalleryItem;
    const video = {
      ...image,
      durationSeconds: 2,
      fullUrl: '/videos/shared',
      kind: 'video',
    } satisfies GalleryItem;
    const recent = asGenerated(
      createImage(99, {
        imageName: 'recent',
        queuedAt: '2026-07-30T12:00:01.000Z',
        starred: true,
      })
    );

    expect(
      mergeGalleryItemWindow({
        backendItems: [image, video, image],
        filter,
        recentImages: [recent],
      }).map(({ kind, name }) => `${kind}:${name}`)
    ).toEqual(['image:recent', 'video:shared', 'image:shared']);

    expect(
      mergeGalleryItemWindow({
        backendItems: [image, video],
        filter: { ...filter, orderDir: 'ASC' },
        recentImages: [],
      }).map(({ kind, name }) => `${kind}:${name}`)
    ).toEqual(['image:shared', 'video:shared']);
  });

  it('keeps all backend items when adding the bounded optimistic overlay', () => {
    const backendItems = Array.from({ length: 600 }, (_, index) =>
      createBackendItem(`image-${index}.png`, new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString())
    );
    const recentImages = getBoundedRecentImages(
      Array.from({ length: 1_000 }, (_, index) => asGenerated(createImage(1_000 + index)))
    );
    const items = mergeGalleryItemWindow({ backendItems, filter, recentImages });

    expect(recentImages).toHaveLength(60);
    expect(items).toHaveLength(660);
    expect(items.some((item) => item.name === backendItems.at(-1)?.name)).toBe(true);
    expect(items.slice(0, 60).map((item) => item.name)).toEqual(recentImages.map((image) => image.imageName).reverse());
  });

  it('preserves backend relevance order and skips the recent overlay while a semantic query is active', () => {
    // Deliberately out of chronological order: relevance is the order.
    const rankedItems = [
      createBackendItem('oldest.png', '2026-01-01T00:00:00.000Z'),
      createBackendItem('newest.png', '2026-07-01T00:00:00.000Z'),
      createBackendItem('middle.png', '2026-03-01T00:00:00.000Z'),
    ];

    expect(
      mergeGalleryItemWindow({
        backendItems: rankedItems,
        filter: { ...filter, semanticQuery: { imageName: 'ref.png', kind: 'image' } },
        recentImages: [asGenerated(createImage(1))],
      }).map((item) => item.name)
    ).toEqual(['oldest.png', 'newest.png', 'middle.png']);
  });

  it('overlays recents onto the unstarred listing only, and never a recent that has since been starred', () => {
    const backend = createBackendItem('backend.png', '2026-01-01T00:00:00.000Z');
    const fresh = asGenerated(createImage(1));
    const starredSince = asGenerated(createImage(2, { starred: true }));

    expect(
      mergeGalleryItemWindow({
        backendItems: [backend],
        filter: { ...filter, starred: false },
        recentImages: [fresh, starredSince],
      }).map((item) => item.name)
    ).toEqual([fresh.imageName, backend.name]);

    const starred = { ...createBackendItem('starred.png', '2026-01-01T00:00:00.000Z'), starred: true };

    expect(
      mergeGalleryItemWindow({
        backendItems: [starred],
        filter: { ...filter, starred: true },
        recentImages: [fresh],
      })
    ).toEqual([starred]);
  });

  it('places an overlaid recent by its instant, not by timestamp shape, against backend items', () => {
    // SQLite and ISO timestamps must sort chronologically; an older recent cannot outrank newer backend rows by
    // separator.
    const backendItems = [
      createBackendItem('newer.png', '2026-08-29 13:01:20.649'),
      createBackendItem('middle.png', '2026-08-29 12:00:00.000'),
    ];
    const recentImages = [
      asGenerated(
        createImage(1, {
          imageName: 'older.png',
          queuedAt: '2026-08-29T02:28:40.566Z',
        })
      ),
    ];

    expect(mergeGalleryItemWindow({ backendItems, filter, recentImages }).map((item) => item.name)).toEqual([
      'newer.png',
      'middle.png',
      'older.png',
    ]);

    expect(
      mergeGalleryItemWindow({
        backendItems,
        filter: { ...filter, orderDir: 'ASC' },
        recentImages,
      }).map((item) => item.name)
    ).toEqual(['older.png', 'middle.png', 'newer.png']);
  });

  it('places a completed batch image by its creation time, not the batch submission time', () => {
    // Sort overlaid completions by creation time while awaiting backend refetch.
    const backendItems = [
      createBackendItem('batch-2.png', '2026-08-29 13:05:00.000'),
      createBackendItem('batch-1.png', '2026-08-29 13:04:00.000'),
    ];
    const recentImages = [
      asGenerated(
        createImage(3, {
          createdAt: '2026-08-29T13:06:00.000Z',
          imageName: 'batch-3.png',
          queuedAt: '2026-08-29T13:00:00.000Z',
        })
      ),
    ];

    expect(mergeGalleryItemWindow({ backendItems, filter, recentImages }).map((item) => item.name)).toEqual([
      'batch-3.png',
      'batch-2.png',
      'batch-1.png',
    ]);
  });

  it('uses SQLite binary ordering for mixed-case and punctuation name ties in both directions', () => {
    const items = ['a.png', 'Z.png', '_draft.png', 'A.png', '!bang.png'].map((name) =>
      createBackendItem(name, '2026-07-30T12:00:00.000Z')
    );

    expect(
      mergeGalleryItemWindow({
        backendItems: items,
        filter: { ...filter, orderDir: 'ASC' },
        recentImages: [],
      }).map((item) => item.name)
    ).toEqual(['!bang.png', 'A.png', 'Z.png', '_draft.png', 'a.png']);

    expect(
      mergeGalleryItemWindow({
        backendItems: items,
        filter: { ...filter, orderDir: 'DESC' },
        recentImages: [],
      }).map((item) => item.name)
    ).toEqual(['a.png', '_draft.png', 'Z.png', 'A.png', '!bang.png']);
  });
});
