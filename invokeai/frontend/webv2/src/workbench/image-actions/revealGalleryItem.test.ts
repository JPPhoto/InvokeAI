import type { GalleryItemRef } from '@features/gallery/contracts';
import type { QueryClient } from '@tanstack/react-query';
import type { WorkbenchCommands, WorkbenchQueries } from '@workbench/workbenchStore';

import { GALLERY_PAGE_SIZE } from '@features/gallery/queries';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { revealGalleryItem } from './revealGalleryItem';

const mocks = vi.hoisted(() => ({
  fetchQuery: vi.fn(),
  resolve: vi.fn(),
  requestReveal: vi.fn(),
}));

vi.mock('@features/gallery', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  galleryItems: { resolve: (...args: unknown[]) => mocks.resolve(...args) },
  toGalleryItemKey: (ref: GalleryItemRef) => `${ref.kind}:${ref.name}`,
}));

vi.mock('@features/gallery/contracts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGallerySettings: () => ({
    boardOrderBy: 'image_count',
    boardOrderDir: 'DESC',
    imageOrderDir: 'DESC',
    paginationMode: 'infinite',
    showArchivedBoards: false,
    showDateBoards: false,
  }),
  isGalleryNavigationCurrent: () => true,
  requestGalleryItemReveal: (...args: unknown[]) => mocks.requestReveal(...args),
}));

vi.mock('@features/gallery/queries', () => ({
  GALLERY_PAGE_SIZE: 60,
  galleryBoardsOptions: () => ({ queryKey: ['boards'] }),
  galleryItemNamesOptions: () => ({ queryKey: ['names'] }),
}));

vi.mock('@workbench/widgetState', () => ({ getProjectWidgetValues: () => ({ galleryView: 'images' }) }));

const createItem = (name: string) => ({
  boardId: 'board-1',
  category: 'general',
  createdAt: '2026-07-30T12:00:00.000Z',
  fullUrl: `/full/${name}`,
  height: 64,
  isIntermediate: false,
  kind: 'image' as const,
  name,
  starred: false,
  thumbnailUrl: `/thumbnail/${name}`,
  width: 64,
});

describe('revealGalleryItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('anchors the view-owned infinite window at an explicit reveal page within the former base window', async () => {
    const requestedItem = createItem('requested');
    const ref: GalleryItemRef = { kind: 'image', name: requestedItem.name };
    const commands = {
      gallery: {
        selectBoard: vi.fn(),
        selectItem: vi.fn(),
        setPage: vi.fn(),
        setView: vi.fn(),
      },
      widgets: { patchValues: vi.fn() },
    } as unknown as WorkbenchCommands;
    const queries = {
      getSnapshot: () => ({ activeProject: {} }),
      isActiveProject: () => true,
    } as unknown as WorkbenchQueries;
    const queryClient = { fetchQuery: mocks.fetchQuery } as unknown as QueryClient;
    const names = Array.from({ length: GALLERY_PAGE_SIZE * 6 }, (_unused, index) => ({
      kind: 'image' as const,
      name: index === GALLERY_PAGE_SIZE * 4 + 3 ? requestedItem.name : `image-${index}`,
    }));

    mocks.resolve.mockResolvedValue(requestedItem);
    mocks.fetchQuery.mockImplementation((options: { queryKey?: unknown[] }) =>
      Promise.resolve(options.queryKey?.[0] === 'names' ? { items: names } : [])
    );

    await revealGalleryItem({ commands, queries, queryClient }, ref, { projectId: 'project-1', sequence: 1 });

    expect(commands.gallery.setPage).toHaveBeenCalledExactlyOnceWith(4);
    expect(commands.gallery.selectItem).toHaveBeenCalledExactlyOnceWith(requestedItem, 'project-1', 4);
    expect(mocks.requestReveal).toHaveBeenCalledExactlyOnceWith('image:requested');
  });
});
