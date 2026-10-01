import type { GalleryUiAdapter } from '@features/gallery/react';
import type { Project } from '@workbench/projectContracts';
import type { ReactNode } from 'react';

import { accountLifecycle } from '@platform/state/accountLifecycle';
import { getProjectWidgetValues } from '@workbench/widgetState';
import { createWorkbenchStore } from '@workbench/workbenchStore';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GalleryUiAdapterProvider } from './GalleryUiAdapter';

let store: ReturnType<typeof createWorkbenchStore>;
let adapter: GalleryUiAdapter;
const noop = () => undefined;
const livePreviewFollow = vi.fn();
const openWorkbenchWidget = vi.fn();

vi.mock('@features/gallery/react', () => ({
  GalleryUiProvider: ({ adapter: next, children }: { adapter: GalleryUiAdapter; children: ReactNode }) => {
    adapter = next;
    return children;
  },
}));
vi.mock('@workbench/widgets/preview/livePreviewFollow', () => ({
  useLivePreviewFollow: () => ({
    sessions: [],
    gallerySessions: [],
    pinnedSessionId: null,
    followedSessionId: 'run:1',
    follow: livePreviewFollow,
    pin: vi.fn(),
    showAll: vi.fn(),
  }),
}));
vi.mock('@workbench/projects/useProjectFileActions', () => ({ useExportLibraryProject: () => noop }));
vi.mock('@workbench/useOpenWorkbenchWidget', () => ({ useOpenWorkbenchWidget: () => openWorkbenchWidget }));
vi.mock('@workbench/WorkbenchContext', () => ({
  useActiveProjectSelector: (selector: (project: Project) => unknown) => selector(store.getSnapshot().activeProject),
  useWorkbenchCommands: () => store.commands,
  useWorkbenchQueries: () => store.queries,
}));

const renderAdapter = () => {
  renderToStaticMarkup(<GalleryUiAdapterProvider>{null}</GalleryUiAdapterProvider>);
  return adapter;
};
const values = (projectId: string) => getProjectWidgetValues(store.queries.getProject(projectId)!, 'gallery');

beforeEach(() => {
  vi.clearAllMocks();
  accountLifecycle.activate('gallery-adapter-test');
  store = createWorkbenchStore();
});
afterEach(() => accountLifecycle.invalidate());

describe('Gallery live-follow adapter', () => {
  it('passes the followed session through and reveals Preview only for a tile click', () => {
    const owner = renderAdapter();

    expect(owner.followedProgressSessionId).toBe('run:1');

    owner.followProgressSession('run:2', { revealPreview: false });
    expect(livePreviewFollow).toHaveBeenCalledExactlyOnceWith('run:2');
    expect(openWorkbenchWidget).not.toHaveBeenCalled();

    owner.followProgressSession('run:2', { revealPreview: true });
    expect(openWorkbenchWidget).toHaveBeenCalledExactlyOnceWith('preview');
  });

  it('ignores a follow retained across an account change', () => {
    const owner = renderAdapter();

    accountLifecycle.activate('gallery-adapter-test');
    owner.followProgressSession('run:2', { revealPreview: true });
    expect(livePreviewFollow).not.toHaveBeenCalled();
  });
});

describe('Gallery settings adapter ownership', () => {
  it('updates the captured active project through the Gallery command', () => {
    const owner = renderAdapter();
    owner.gallery.updateSettings({ imageDensityPercent: 24, paginationMode: 'paginated' });

    expect(values(owner.projectId)).toMatchObject({ imageDensityPercent: 24, paginationMode: 'paginated' });
  });

  it('rejects a retained callback after switching projects and accepts the new project binding', () => {
    const first = renderAdapter();
    const firstValues = values(first.projectId);
    const secondProject = store.commands.projects.create();
    const secondValues = values(secondProject.id);

    first.gallery.updateSettings({ imageDensityPercent: 24 });
    expect(values(first.projectId)).toEqual(firstValues);
    expect(values(secondProject.id)).toEqual(secondValues);

    const second = renderAdapter();
    second.gallery.updateSettings({ imageDensityPercent: 12 });
    expect(values(secondProject.id).imageDensityPercent).toBe(12);
    expect(values(first.projectId)).toEqual(firstValues);
  });

  it('rejects retained callbacks after the account lifetime changes even with the same project id', () => {
    const previous = renderAdapter();
    const before = values(previous.projectId);
    accountLifecycle.activate('gallery-adapter-test');

    previous.gallery.updateSettings({ showImageDimensions: true });
    expect(values(previous.projectId)).toEqual(before);

    renderAdapter().gallery.updateSettings({ showImageDimensions: true });
    expect(values(previous.projectId).showImageDimensions).toBe(true);
  });
});

describe('Gallery selection adapter ownership', () => {
  it('forwards absolute selection pages with the captured project to Workbench commands', () => {
    const owner = renderAdapter();
    const item = {
      boardId: 'board-1',
      category: 'general',
      createdAt: '2026-07-30T12:00:00.000Z',
      fullUrl: '/full/deep.png',
      height: 64,
      isIntermediate: false,
      kind: 'image',
      name: 'deep.png',
      starred: false,
      thumbnailUrl: '/thumbnail/deep.png',
      width: 64,
    } as const;

    owner.gallery.selectItem(item, 10);
    expect(values(owner.projectId)).toMatchObject({
      selectedImagePage: 10,
      selectedImageQuery: { page: 10 },
    });

    owner.gallery.setItemMultiSelection(['image:deep.png'], item, 11);
    expect(values(owner.projectId)).toMatchObject({
      selectedImagePage: 11,
      selectedImageQuery: { page: 11 },
    });

    owner.gallery.toggleItemSelection({ ...item, name: 'toggled.png' }, null, 12);
    expect(values(owner.projectId)).toMatchObject({
      selectedImagePage: 12,
      selectedImageQuery: { page: 12 },
    });
  });

  it('ignores retained selection callbacks after the account lifetime changes', () => {
    const previous = renderAdapter();
    const projectId = previous.projectId;
    const before = values(projectId);
    accountLifecycle.activate('gallery-adapter-test');

    previous.gallery.selectItem(
      {
        boardId: 'board-1',
        category: 'general',
        createdAt: '2026-07-30T12:00:00.000Z',
        fullUrl: '/full/deep.png',
        height: 64,
        isIntermediate: false,
        kind: 'image',
        name: 'deep.png',
        starred: false,
        thumbnailUrl: '/thumbnail/deep.png',
        width: 64,
      },
      10
    );

    expect(values(projectId)).toEqual(before);
  });
});
