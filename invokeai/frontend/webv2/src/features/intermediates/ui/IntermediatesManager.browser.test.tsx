import type {
  IntermediatesOperation,
  IntermediatesPreview,
  IntermediatesRow,
  IntermediatesSummary,
} from '@features/intermediates/core/types';

import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { system } from '@theme/system';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  createIntermediatesPreview: vi.fn(),
  getIntermediatesOperation: vi.fn(),
  getIntermediatesSummary: vi.fn(),
  retryIntermediatesOperation: vi.fn(),
  startIntermediatesOperation: vi.fn(),
}));

vi.mock('@features/intermediates/data/api', () => ({
  createIntermediatesPreview: dependencies.createIntermediatesPreview,
  getIntermediatesOperation: dependencies.getIntermediatesOperation,
  getIntermediatesSummary: dependencies.getIntermediatesSummary,
  retryIntermediatesOperation: dependencies.retryIntermediatesOperation,
  startIntermediatesOperation: dependencies.startIntermediatesOperation,
}));
vi.mock('@features/intermediates/data/realtime', () => ({ attachIntermediatesRealtime: () => () => undefined }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0
        ? `${key}(${Object.entries(options)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(',')})`
        : key,
  }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (projectId: string | null, name: string | null, safe: number): IntermediatesRow => ({
  coverImageName: null,
  images: { active: 1, recent: 0, referenced: 2, safe },
  projectId,
  projectName: name,
  reclaimableBytes: safe * 1_048_576,
  referencedBytes: 0,
  unknownSizeCount: 0,
  userDisplayName: 'Alice',
  userEmail: 'alice@example.com',
  userId: 'alice',
  videos: { active: 0, recent: 0, referenced: 0, safe: 0 },
});

const summaryOf = (items: IntermediatesRow[]): IntermediatesSummary => ({
  canManageEveryone: false,
  items,
  limit: 50,
  measuring: false,
  offset: 0,
  recentGraceSeconds: 1800,
  total: items.length,
  totals: {
    inUseImages: items.length * 3,
    inUseVideos: 0,
    reclaimableBytes: items.reduce((sum, item) => sum + item.reclaimableBytes, 0),
    rows: items.length,
    safeImages: items.reduce((sum, item) => sum + item.images.safe, 0),
    safeVideos: 0,
    unknownSizeCount: 0,
  },
});

const previewOf = (mode: 'safe' | 'force', deleteImages: number): IntermediatesPreview => ({
  affectedDocuments:
    mode === 'force' ? [{ kind: 'project', name: 'Portraits', ownerId: 'p1', references: 2, userId: 'alice' }] : [],
  affectedDocumentsHidden: 0,
  createdAt: 'now',
  expiresAt: 'later',
  impact: {
    deleteImages,
    deleteVideos: 0,
    keepActiveImages: 1,
    keepActiveVideos: 0,
    keepRecentImages: 0,
    keepRecentVideos: 0,
    keepReferencedImages: mode === 'safe' ? 2 : 0,
    keepReferencedVideos: 0,
    reclaimableBytes: deleteImages * 1_048_576,
    unknownSizeCount: 0,
  },
  mode,
  previewId: `preview-${mode}`,
  scope: { kind: 'owner', userId: 'alice' },
  targetRows: 1,
});

const operationOf = (status: IntermediatesOperation['status']): IntermediatesOperation => ({
  completedAt: status === 'completed' ? 'later' : null,
  createdAt: 'now',
  error: null,
  mode: 'safe',
  operationId: 'op-1',
  progress: {
    deletedImages: status === 'completed' ? 4 : 2,
    deletedVideos: 0,
    failedImages: 0,
    failedVideos: 0,
    pendingDiskCleanup: 0,
    processedImages: status === 'completed' ? 4 : 2,
    processedVideos: 0,
    reclaimedBytes: 4_194_304,
    retainedImages: 0,
    retainedVideos: 0,
    unknownSizeCount: 0,
    unresolvedImages: 0,
    unresolvedVideos: 0,
  },
  retriedByOperationId: null,
  retriedFromOperationId: null,
  scope: { kind: 'owner', userId: 'alice' },
  startedAt: 'now',
  status,
  targetImages: 4,
  targetVideos: 0,
  userId: 'alice',
});

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

const renderManager = async (
  options: { focusProjectId?: string; currentUserId?: string | null } = {}
): Promise<void> => {
  host = document.createElement('div');
  host.style.height = '640px';
  host.style.width = '900px';
  host.style.display = 'flex';
  host.style.flexDirection = 'column';
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { requestIntermediatesFocus } = await import('@features/intermediates/data/focus');
  const { IntermediatesManager } = await import('./IntermediatesManager');

  if (options.focusProjectId) {
    requestIntermediatesFocus({ projectId: options.focusProjectId });
  }
  await act(() => {
    root.render(
      <ChakraProvider value={system}>
        <QueryClientProvider client={queryClient}>
          <IntermediatesManager
            canClearOthersIntermediates={false}
            currentUserId={options.currentUserId === undefined ? 'alice' : options.currentUserId}
          />
        </QueryClientProvider>
      </ChakraProvider>
    );
  });
};

/** Chakra puts the accessible name on the checkbox root; the hidden input inside it carries the state. */
const checkbox = (label: string): { click: () => void; checked: boolean } => {
  const rootElement = host.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  expect(rootElement, label).not.toBeNull();
  const input = rootElement!.querySelector<HTMLInputElement>('input');
  expect(input, `${label} input`).not.toBeNull();
  return { checked: input!.checked, click: () => input!.click() };
};

const buttonWithText = (text: string, scope: ParentNode = document): HTMLButtonElement => {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
    candidate.textContent?.includes(text)
  );
  expect(button, text).toBeDefined();
  return button!;
};

const setInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('IntermediatesManager', () => {
  beforeEach(() => {
    dependencies.getIntermediatesSummary
      .mockReset()
      .mockImplementation((params: { search?: string }) =>
        Promise.resolve(
          summaryOf(
            params.search?.trim()
              ? [row('p1', 'Portraits', 4)]
              : [row('p1', 'Portraits', 4), row('p2', 'Landscapes', 1), row(null, null, 7)]
          )
        )
      );
    dependencies.createIntermediatesPreview
      .mockReset()
      .mockImplementation(({ mode }: { mode: 'safe' | 'force' }) => Promise.resolve(previewOf(mode, 4)));
    dependencies.startIntermediatesOperation.mockReset().mockResolvedValue(operationOf('running'));
    dependencies.getIntermediatesOperation.mockReset().mockResolvedValue(operationOf('completed'));
    dependencies.retryIntermediatesOperation.mockReset();
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    host?.remove();
  });

  it('lists projects with used and unused counts and keeps Delete disabled until something is selected', async () => {
    await renderManager();
    await vi.waitFor(() => expect(host.textContent).toContain('Portraits'));

    expect(host.textContent).toContain('intermediates.list.unassigned');
    expect(host.querySelectorAll('[role="list"] li')).toHaveLength(3);
    expect(host.textContent).toContain('intermediates.list.used');
    expect(host.textContent).toContain('intermediates.list.unused');
    expect(buttonWithText('intermediates.list.delete', host).disabled).toBe(true);

    await act(() => checkbox('intermediates.list.selectRow(name=Portraits)').click());
    expect(buttonWithText('intermediates.list.delete', host).disabled).toBe(false);
    expect(host.textContent).toContain('count=1');

    await act(() => checkbox('intermediates.list.selectAll').click());
    expect(host.textContent).toContain('count=3');

    const search = host.querySelector<HTMLInputElement>('input[aria-label="intermediates.searchLabel"]');
    expect(search).not.toBeNull();
    await act(() => setInputValue(search!, 'Port'));
    await vi.waitFor(() =>
      expect(dependencies.getIntermediatesSummary).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'Port' }),
        expect.anything()
      )
    );
    // A search hides rows; hidden selections must not survive it.
    expect(buttonWithText('intermediates.list.delete', host).disabled).toBe(true);
  });

  it('previews the delete, starts the operation, and reports it once it settles', async () => {
    await renderManager({ focusProjectId: 'p1' });
    await vi.waitFor(() => expect(host.textContent).toContain('Portraits'));
    expect(checkbox('intermediates.list.selectRow(name=Portraits)').checked).toBe(true);

    await act(() => buttonWithText('intermediates.list.delete', host).click());
    await vi.waitFor(() =>
      expect(dependencies.createIntermediatesPreview).toHaveBeenCalledWith(
        { mode: 'safe', scope: { kind: 'selection', targets: [{ projectId: 'p1', userId: 'alice' }] } },
        expect.anything()
      )
    );
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    await vi.waitFor(() => expect(dialog!.textContent).toContain('intermediates.dialog.reclaim(size=4.0 MB)'));
    expect(dialog!.textContent).toContain('intermediates.dialog.kept(count=3)');
    // The impact is the dialog's accessible description even though it arrives after the dialog opens.
    const describedBy = dialog!.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy!)?.textContent).toContain('intermediates.dialog.reclaim(size=4.0 MB)');

    const confirm = buttonWithText('intermediates.dialog.confirm', dialog!);
    expect(confirm.disabled).toBe(false);
    await act(() => confirm.click());
    await vi.waitFor(() =>
      expect(dependencies.startIntermediatesOperation).toHaveBeenCalledWith(
        expect.objectContaining({ previewId: 'preview-safe' }),
        expect.anything()
      )
    );
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    expect(host.textContent).toContain('intermediates.operation.status.running');
    await vi.waitFor(() => expect(host.textContent).toContain('intermediates.operation.status.completed'), {
      timeout: 5_000,
    });
    expect(host.textContent).not.toContain('intermediates.operation.retry');
  });

  it('gates a force delete behind the disclosure, an acknowledgement and the typed word', async () => {
    await renderManager({ focusProjectId: 'p1' });
    await vi.waitFor(() => expect(host.textContent).toContain('Portraits'));
    await act(() => buttonWithText('intermediates.list.delete', host).click());
    const dialog = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('[role="alertdialog"]');
      expect(element).not.toBeNull();
      return element!;
    });
    await vi.waitFor(() => expect(dialog.textContent).toContain('intermediates.dialog.reclaim'));

    const toggles = () => [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    await act(() => toggles()[0]!.click());
    await vi.waitFor(() =>
      expect(dependencies.createIntermediatesPreview).toHaveBeenLastCalledWith(
        expect.objectContaining({ mode: 'force' }),
        expect.anything()
      )
    );
    await vi.waitFor(() => expect(dialog.textContent).toContain('Portraits'));
    const confirm = () => buttonWithText('intermediates.dialog.forceConfirm', dialog);
    expect(confirm().disabled).toBe(true);

    await act(() => toggles()[1]!.click());
    expect(confirm().disabled).toBe(true);

    const typed = dialog.querySelector<HTMLInputElement>('input:not([type="checkbox"])');
    expect(typed).not.toBeNull();
    await act(() => setInputValue(typed!, 'CLEAR'));
    expect(confirm().disabled).toBe(false);
  });

  it('reports a failed load with a retry and an empty library plainly', async () => {
    dependencies.getIntermediatesSummary
      .mockReset()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(summaryOf([]));
    await renderManager();

    await vi.waitFor(() => expect(host.textContent).toContain('intermediates.errors.couldNotLoad'));
    await act(() => buttonWithText('common.retry', host).click());
    await vi.waitFor(() => expect(host.textContent).toContain('intermediates.empty.title'));
  });

  it('preselects the requested project in single-user mode, where the session names no account', async () => {
    await renderManager({ currentUserId: null, focusProjectId: 'p2' });
    await vi.waitFor(() => expect(host.textContent).toContain('Landscapes'));

    expect(checkbox('intermediates.list.selectRow(name=Landscapes)').checked).toBe(true);
    expect(checkbox('intermediates.list.selectRow(name=Portraits)').checked).toBe(false);
    expect(buttonWithText('intermediates.list.delete', host).disabled).toBe(false);
    expect(host.textContent).toContain('count=1');
  });

  it('keeps picks from another page in the estimate and the targets', async () => {
    const manyRows = Array.from({ length: 60 }, (_, index) => row(`p${index}`, `Project ${index}`, 1));
    dependencies.getIntermediatesSummary.mockReset().mockImplementation((params: { offset?: number }) => {
      const offset = params.offset ?? 0;
      const summary = summaryOf(manyRows.slice(offset, offset + 50));
      return Promise.resolve({ ...summary, offset, total: manyRows.length });
    });
    await renderManager();
    await vi.waitFor(() => expect(host.textContent).toContain('Project 0'));

    await act(() => checkbox('intermediates.list.selectRow(name=Project 1)').click());
    await act(() => buttonWithText('common.nextPage', host).click());
    await vi.waitFor(() => expect(host.textContent).toContain('Project 55'));
    await act(() => checkbox('intermediates.list.selectRow(name=Project 55)').click());
    expect(host.textContent).toContain('count=2');

    await act(() => buttonWithText('intermediates.list.delete', host).click());
    await vi.waitFor(() =>
      expect(dependencies.createIntermediatesPreview).toHaveBeenCalledWith(
        {
          mode: 'safe',
          scope: {
            kind: 'selection',
            targets: [
              { projectId: 'p1', userId: 'alice' },
              { projectId: 'p55', userId: 'alice' },
            ],
          },
        },
        expect.anything()
      )
    );
  });
});
