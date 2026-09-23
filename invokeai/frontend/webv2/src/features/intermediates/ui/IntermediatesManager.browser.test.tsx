import type {
  IntermediatesOperation,
  IntermediatesPreview,
  IntermediatesRow,
  IntermediatesSummary,
} from '@features/intermediates/core/types';

import { ChakraProvider } from '@chakra-ui/react';
import { ApiError } from '@platform/transport/http';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { system } from '@theme/system';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';

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
  hasMoreEligible: false,
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
  options: { focusProjectId?: string; currentUserId?: string | null; canClearOthersIntermediates?: boolean } = {}
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
            canClearOthersIntermediates={options.canClearOthersIntermediates ?? false}
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
    sessionStorage.clear();
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
    const { followIntermediatesOperation } = await import('@features/intermediates/data/operationStore');
    followIntermediatesOperation(null);
  });

  it('starts an admin in their own account and exposes an explicit everyone switch', async () => {
    await renderManager({ canClearOthersIntermediates: true });
    host.style.width = '400px';
    await vi.waitFor(() =>
      expect(dependencies.getIntermediatesSummary).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'alice' }),
        expect.anything()
      )
    );
    const everyoneControl = host.querySelector<HTMLElement>('[aria-label="intermediates.owner.showEveryone"]')!;
    expect(everyoneControl.getBoundingClientRect().right).toBeLessThanOrEqual(host.getBoundingClientRect().right);
    await page.screenshot({ path: '../../../../artifacts/intermediates/admin-own-narrow.png' });
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="intermediates.owner.showEveryone"]')!.click());
    await vi.waitFor(() =>
      expect(dependencies.getIntermediatesSummary).toHaveBeenLastCalledWith(
        expect.objectContaining({ ownerId: null }),
        expect.anything()
      )
    );
    await act(() => buttonWithText('intermediates.owner.showMine', host).click());
    expect(host.querySelector('[aria-label="intermediates.owner.showEveryone"]')).not.toBeNull();
    expect(host.textContent).not.toContain('intermediates.owner.showMine');
  });

  it('fetches a focused project by id even when it is outside the first page', async () => {
    dependencies.getIntermediatesSummary.mockImplementation((params: { projectId?: string }) =>
      Promise.resolve(summaryOf(params.projectId === 'p55' ? [row('p55', 'Far project', 2)] : [row('p1', 'First', 1)]))
    );
    await renderManager({ focusProjectId: 'p55' });
    await vi.waitFor(() => expect(host.textContent).toContain('Far project'));
    expect(checkbox('intermediates.list.selectRow(name=Far project)').checked).toBe(true);
    expect(dependencies.getIntermediatesSummary).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p55' }),
      expect.anything()
    );
  });

  it('keeps Select all within a focused project', async () => {
    dependencies.getIntermediatesSummary.mockImplementation((params: { projectId?: string }) =>
      Promise.resolve(summaryOf(params.projectId === 'p1' ? [row('p1', 'Portraits', 4)] : [row('p2', 'Other', 3)]))
    );
    await renderManager({ focusProjectId: 'p1' });
    await vi.waitFor(() => expect(host.textContent).toContain('Portraits'));
    await act(() => checkbox('intermediates.list.selectAll').click());
    await act(() => checkbox('intermediates.list.selectAll').click());
    await act(() => buttonWithText('intermediates.list.delete', host).click());
    await vi.waitFor(() =>
      expect(dependencies.createIntermediatesPreview).toHaveBeenCalledWith(
        { mode: 'safe', scope: { kind: 'selection', targets: [{ projectId: 'p1', userId: 'alice' }] } },
        expect.anything()
      )
    );
  });

  it('labels a bounded preview as a repeatable batch', async () => {
    dependencies.createIntermediatesPreview.mockResolvedValue({ ...previewOf('safe', 4), hasMoreEligible: true });
    await renderManager({ focusProjectId: 'p1' });
    await vi.waitFor(() => expect(host.textContent).toContain('Portraits'));
    await act(() => buttonWithText('intermediates.list.delete', host).click());
    await vi.waitFor(() =>
      expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('intermediates.dialog.batchLimit')
    );
  });

  it('replays a confirmed start receipt after a reload', async () => {
    const { recordPendingIntermediatesStart } = await import('@features/intermediates/data/operationStore');
    recordPendingIntermediatesStart({ idempotencyKey: 'confirmed-key', previewId: 'confirmed-preview' });

    await renderManager();
    await vi.waitFor(() =>
      expect(dependencies.startIntermediatesOperation).toHaveBeenCalledWith(
        { idempotencyKey: 'confirmed-key', previewId: 'confirmed-preview' },
        expect.anything()
      )
    );
    await vi.waitFor(() => expect(host.textContent).toContain('intermediates.operation.status.running'));
    expect(sessionStorage.getItem('invokeai:webv2:intermediates-receipt:local')).toContain('op-1');
  });

  it('does not let a late start replay replace a newer confirmed operation', async () => {
    const { activeOperationStore, recordPendingIntermediatesStart } =
      await import('@features/intermediates/data/operationStore');
    let resolveOld!: (operation: IntermediatesOperation) => void;
    const oldStart = new Promise<IntermediatesOperation>((resolve) => {
      resolveOld = resolve;
    });
    recordPendingIntermediatesStart({ idempotencyKey: 'old-key', previewId: 'old-preview' });
    dependencies.startIntermediatesOperation.mockImplementation((request: { previewId: string }) =>
      request.previewId === 'old-preview'
        ? oldStart
        : Promise.resolve({ ...operationOf('running'), operationId: 'new-op' })
    );
    await renderManager({ focusProjectId: 'p1' });
    await vi.waitFor(() =>
      expect(dependencies.startIntermediatesOperation).toHaveBeenCalledWith(
        { idempotencyKey: 'old-key', previewId: 'old-preview' },
        expect.anything()
      )
    );
    await vi.waitFor(() => expect(host.textContent).toContain('Portraits'));
    await act(() => buttonWithText('intermediates.list.delete', host).click());
    const dialog = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('[role="alertdialog"]');
      expect(element).not.toBeNull();
      return element!;
    });
    await vi.waitFor(() => expect(dialog.textContent).toContain('intermediates.dialog.reclaim'));
    await act(() => buttonWithText('intermediates.dialog.confirm', dialog).click());
    await vi.waitFor(() => expect(activeOperationStore.getSnapshot().operationId).toBe('new-op'));
    await act(() => resolveOld({ ...operationOf('completed'), operationId: 'old-op' }));
    expect(activeOperationStore.getSnapshot().operationId).toBe('new-op');
  });

  it('does not let an old rejected replay erase a newer pending confirmation', async () => {
    const { recordPendingIntermediatesStart } = await import('@features/intermediates/data/operationStore');
    let rejectOld!: (error: Error) => void;
    let resolveNew!: (operation: IntermediatesOperation) => void;
    const oldStart = new Promise<IntermediatesOperation>((_resolve, reject) => {
      rejectOld = reject;
    });
    const newStart = new Promise<IntermediatesOperation>((resolve) => {
      resolveNew = resolve;
    });
    recordPendingIntermediatesStart({ idempotencyKey: 'old-key', previewId: 'old-preview' });
    dependencies.startIntermediatesOperation.mockImplementation((request: { previewId: string }) =>
      request.previewId === 'old-preview' ? oldStart : newStart
    );
    await renderManager({ focusProjectId: 'p1' });
    await vi.waitFor(() =>
      expect(dependencies.startIntermediatesOperation).toHaveBeenCalledWith(
        { idempotencyKey: 'old-key', previewId: 'old-preview' },
        expect.anything()
      )
    );
    await vi.waitFor(() => expect(host.textContent).toContain('Portraits'));
    await act(() => buttonWithText('intermediates.list.delete', host).click());
    const dialog = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('[role="alertdialog"]');
      expect(element).not.toBeNull();
      return element!;
    });
    await vi.waitFor(() => expect(dialog.textContent).toContain('intermediates.dialog.reclaim'));
    await act(() => buttonWithText('intermediates.dialog.confirm', dialog).click());
    await vi.waitFor(() =>
      expect(sessionStorage.getItem('invokeai:webv2:intermediates-receipt:local')).toContain('preview-safe')
    );
    await act(() => rejectOld(new ApiError('Rejected', 409)));
    expect(sessionStorage.getItem('invokeai:webv2:intermediates-receipt:local')).toContain('preview-safe');
    await act(() => resolveNew({ ...operationOf('running'), operationId: 'new-op' }));
  });

  it('drops a definitively rejected start receipt', async () => {
    const { recordPendingIntermediatesStart } = await import('@features/intermediates/data/operationStore');
    recordPendingIntermediatesStart({ idempotencyKey: 'rejected-key', previewId: 'rejected-preview' });
    dependencies.startIntermediatesOperation.mockRejectedValue(new ApiError('Unavailable', 409));
    await renderManager();
    await vi.waitFor(() => expect(host.textContent).toContain('Unavailable'));
    expect(sessionStorage.getItem('invokeai:webv2:intermediates-receipt:local')).toBeNull();
  });

  it('follows a retry whose response was lost before reload', async () => {
    const { followIntermediatesOperation } = await import('@features/intermediates/data/operationStore');
    followIntermediatesOperation('op-1');
    dependencies.getIntermediatesOperation.mockImplementation((operationId: string) =>
      Promise.resolve(
        operationId === 'op-1'
          ? { ...operationOf('failed'), retriedByOperationId: 'op-2' }
          : { ...operationOf('running'), operationId: 'op-2' }
      )
    );
    await renderManager();
    await vi.waitFor(() =>
      expect(sessionStorage.getItem('invokeai:webv2:intermediates-receipt:local')).toContain('op-2')
    );
    expect(host.textContent).toContain('intermediates.operation.status.running');
  });

  it('does not let a late retry lookup replace a newer followed operation', async () => {
    const { activeOperationStore, followIntermediatesOperation } =
      await import('@features/intermediates/data/operationStore');
    let resolveOriginal!: (operation: IntermediatesOperation) => void;
    const original = new Promise<IntermediatesOperation>((resolve) => {
      resolveOriginal = resolve;
    });
    dependencies.getIntermediatesOperation.mockImplementation((operationId: string) =>
      operationId === 'op-1' ? original : Promise.resolve({ ...operationOf('running'), operationId })
    );
    followIntermediatesOperation('op-1');
    await renderManager();
    await vi.waitFor(() =>
      expect(dependencies.getIntermediatesOperation).toHaveBeenCalledWith('op-1', expect.anything())
    );
    await act(() => followIntermediatesOperation('newer-op'));
    await act(() => resolveOriginal({ ...operationOf('failed'), retriedByOperationId: 'op-2' }));
    await vi.waitFor(() =>
      expect(dependencies.getIntermediatesOperation).toHaveBeenCalledWith('op-2', expect.anything())
    );
    expect(activeOperationStore.getSnapshot().operationId).toBe('newer-op');
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
  it('keeps all 119 other projects selected across pages and safe/force previews', async () => {
    const manyRows = Array.from({ length: 120 }, (_, index) => row(`p${index}`, `Project ${index}`, 1));
    const totals = summaryOf(manyRows).totals;
    dependencies.getIntermediatesSummary
      .mockReset()
      .mockImplementation((params: { offset?: number; limit?: number }) => {
        const offset = params.offset ?? 0;
        return Promise.resolve({
          ...summaryOf(manyRows.slice(offset, offset + (params.limit ?? 50))),
          offset,
          total: 120,
          totals,
        });
      });
    await renderManager();
    await vi.waitFor(() => expect(host.textContent).toContain('Project 0'));
    await act(() => checkbox('intermediates.list.selectAll').click());
    await act(() => checkbox('intermediates.list.selectRow(name=Project 1)').click());
    await vi.waitFor(() => expect(host.textContent).toContain('count=119'));
    await act(() => buttonWithText('common.nextPage', host).click());
    await vi.waitFor(() => expect(host.textContent).toContain('Project 55'));
    expect(checkbox('intermediates.list.selectRow(name=Project 55)').checked).toBe(true);
    expect(checkbox('intermediates.list.selectAll').checked).toBe(false);
    await act(() => buttonWithText('common.nextPage', host).click());
    await vi.waitFor(() => expect(host.textContent).toContain('Project 119'));
    expect(checkbox('intermediates.list.selectRow(name=Project 119)').checked).toBe(true);
    await act(() => buttonWithText('intermediates.list.delete', host).click());
    const targets = manyRows
      .filter(({ projectId }) => projectId !== 'p1')
      .map(({ projectId, userId }) => ({ projectId, userId }));
    await vi.waitFor(() =>
      expect(dependencies.createIntermediatesPreview).toHaveBeenLastCalledWith(
        { mode: 'safe', scope: { kind: 'selection', targets } },
        expect.anything()
      )
    );
    await act(() => document.querySelector<HTMLLabelElement>('[role="alertdialog"] label')!.click());
    await vi.waitFor(() =>
      expect(dependencies.createIntermediatesPreview).toHaveBeenLastCalledWith(
        { mode: 'force', scope: { kind: 'selection', targets } },
        expect.anything()
      )
    );
  });

  it('reconciles excluded rows after refresh across pages without forgetting their identities', async () => {
    let currentRows = Array.from({ length: 120 }, (_, index) => row(`p${index}`, `Project ${index}`, 1));
    dependencies.getIntermediatesSummary
      .mockReset()
      .mockImplementation((params: { offset?: number; limit?: number }) => {
        const offset = params.offset ?? 0;
        return Promise.resolve({
          ...summaryOf(currentRows),
          items: currentRows.slice(offset, offset + (params.limit ?? 50)),
          offset,
        });
      });
    await renderManager();
    await vi.waitFor(() => expect(host.textContent).toContain('Project 0'));
    await act(() => checkbox('intermediates.list.selectAll').click());
    await act(() => checkbox('intermediates.list.selectRow(name=Project 1)').click());
    await vi.waitFor(() => expect(host.textContent).toContain('count=119'));
    const snapshots = () =>
      dependencies.getIntermediatesSummary.mock.calls.filter(([params]) => params.limit === 1000).length;
    const initialSnapshots = snapshots();
    await act(() => buttonWithText('common.nextPage', host).click());
    await vi.waitFor(() => expect(host.textContent).toContain('Project 55'));
    expect(snapshots()).toBe(initialSnapshots);

    currentRows = [row('p55', 'Project 55', 1)];
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="intermediates.refresh"]')!.click());
    await vi.waitFor(() => expect(host.textContent).toContain('intermediates.selection.estimate(count=1,'));
    expect(checkbox('intermediates.list.selectRow(name=Project 55)').checked).toBe(true);
    expect(buttonWithText('intermediates.list.delete', host).disabled).toBe(false);

    currentRows = [row('p1', 'Project 1', 1), row('p55', 'Project 55', 1)];
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="intermediates.refresh"]')!.click());
    await vi.waitFor(() => expect(host.textContent).toContain('Project 1'));
    expect(checkbox('intermediates.list.selectRow(name=Project 1)').checked).toBe(false);
    await vi.waitFor(() =>
      expect(host.textContent).toContain(
        'intermediates.selection.estimate(count=1,images=intermediates.counts.images(count=1)'
      )
    );

    // Same global totals, but all reclaimable bytes have moved to the still-selected row.
    currentRows = [row('p1', 'Project 1', 0), row('p55', 'Project 55', 2)];
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="intermediates.refresh"]')!.click());
    await vi.waitFor(() =>
      expect(host.textContent).toContain(
        'intermediates.selection.estimate(count=1,images=intermediates.counts.images(count=2)'
      )
    );
    expect(checkbox('intermediates.list.selectRow(name=Project 1)').checked).toBe(false);
    await act(() => buttonWithText('intermediates.list.delete', host).click());
    await vi.waitFor(() =>
      expect(dependencies.createIntermediatesPreview).toHaveBeenLastCalledWith(
        { mode: 'safe', scope: { kind: 'selection', targets: [{ projectId: 'p55', userId: 'alice' }] } },
        expect.anything()
      )
    );
  });

  it('bounds exclusion snapshots and reports the preview limit instead of guessing a selection estimate', async () => {
    const manyRows = Array.from({ length: 1001 }, (_, index) => row(`p${index}`, `Project ${index}`, 1));
    dependencies.getIntermediatesSummary
      .mockReset()
      .mockImplementation((params: { offset?: number; limit?: number }) => {
        const offset = params.offset ?? 0;
        return Promise.resolve({
          ...summaryOf(manyRows),
          items: manyRows.slice(offset, offset + (params.limit ?? 50)),
          offset,
        });
      });
    await renderManager();
    await vi.waitFor(() => expect(host.textContent).toContain('Project 0'));
    await act(() => checkbox('intermediates.list.selectAll').click());
    await act(() => checkbox('intermediates.list.selectRow(name=Project 1)').click());
    await vi.waitFor(() => expect(host.textContent).toContain('intermediates.selection.tooManyRows'));
    expect(dependencies.getIntermediatesSummary.mock.calls.filter(([params]) => params.limit === 1000)).toHaveLength(1);
    expect(buttonWithText('intermediates.list.delete', host).disabled).toBe(false);
    await act(() => buttonWithText('intermediates.list.delete', host).click());
    await vi.waitFor(() =>
      expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('intermediates.dialog.tooManyRows')
    );
    expect(dependencies.createIntermediatesPreview).not.toHaveBeenCalled();
  });
});
