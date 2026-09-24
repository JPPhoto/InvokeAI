import type {
  IntermediatesOperation,
  IntermediatesPreview,
  IntermediatesRow,
  IntermediatesSummary,
} from '@features/intermediates/core/types';

import { ChakraProvider } from '@chakra-ui/react';
import { accountLifecycle } from '@platform/state/accountLifecycle';
import { ApiError } from '@platform/transport/http';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { system } from '@theme/system';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';

const dependencies = vi.hoisted(() => ({
  createIntermediatesPreview: vi.fn(),
  getIntermediatesOperation: vi.fn(),
  getIntermediatesSummary: vi.fn(),
  listIntermediatesOperations: vi.fn(),
  startIntermediatesOperation: vi.fn(),
}));

vi.mock('@features/intermediates/data/api', () => ({
  createIntermediatesPreview: dependencies.createIntermediatesPreview,
  getIntermediatesOperation: dependencies.getIntermediatesOperation,
  getIntermediatesSummary: dependencies.getIntermediatesSummary,
  listIntermediatesOperations: dependencies.listIntermediatesOperations,
  startIntermediatesOperation: dependencies.startIntermediatesOperation,
}));
vi.mock('@features/intermediates/data/realtime', () => ({ attachIntermediatesRealtime: () => () => undefined }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { resolvedLanguage: 'en' },
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

const documentOf = (userId: string) => ({
  userDisplayName: userId === 'bob' ? 'Bob' : 'Alice',
  userEmail: `${userId}@example.com`,
  userId,
});

const forceAffectedDocuments: IntermediatesPreview['affectedDocuments'] = [
  { ...documentOf('alice'), kind: 'project', name: 'Portraits', ownerId: 'p1', references: 2 },
  { ...documentOf('alice'), kind: 'client_state', name: null, ownerId: 'canvas', references: 1 },
  { ...documentOf('alice'), kind: 'quarantined_project', name: 'Old sketch', ownerId: 'q1', references: 1 },
  { ...documentOf('bob'), kind: 'client_state', name: null, ownerId: 'canvas', references: 1 },
];

const previewOf = (mode: 'safe' | 'force', deleteImages: number): IntermediatesPreview => ({
  affectedDocuments: mode === 'force' ? forceAffectedDocuments : [],
  affectedDocumentsTotal: mode === 'force' ? forceAffectedDocuments.length : 0,
  createdAt: '2026-09-24T12:00:00.000Z',
  expiresAt: '2026-09-24T12:10:00.000Z',
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
  createdAt: '2026-09-24T12:00:00.000Z',
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
  },
  scope: { kind: 'owner', userId: 'alice' },
  startedAt: 'now',
  status,
  targetImages: 4,
  targetVideos: 0,
  userId: 'alice',
});

const matchingScope = (overrides: Partial<Extract<IntermediatesOperation['scope'], { kind: 'matching' }>> = {}) => ({
  excluded: [],
  kind: 'matching' as const,
  projectId: null,
  search: null,
  userId: 'alice',
  ...overrides,
});

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

const renderManager = async (
  options: {
    focusProjectId?: string;
    focusOwner?: { ownerId: string; ownerLabel?: string };
    currentUserId?: string | null;
    currentUserLabel?: string;
    canClearOthersIntermediates?: boolean;
    strict?: boolean;
  } = {}
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

  if (options.focusProjectId || options.focusOwner) {
    requestIntermediatesFocus({ projectId: options.focusProjectId, ...options.focusOwner });
  }
  const manager = (
    <ChakraProvider value={system}>
      <QueryClientProvider client={queryClient}>
        <IntermediatesManager
          canClearOthersIntermediates={options.canClearOthersIntermediates ?? false}
          currentUserId={options.currentUserId === undefined ? 'alice' : options.currentUserId}
          currentUserLabel={options.currentUserLabel}
        />
      </QueryClientProvider>
    </ChakraProvider>
  );
  await act(() => {
    root.render(options.strict ? <StrictMode>{manager}</StrictMode> : manager);
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

/** Serves `operation` to polls and pushes it into the cache the way a realtime update does, without waiting a poll. */
const followOperation = async (initial: IntermediatesOperation) => {
  const { intermediatesOperationQueryOptions } = await import('@features/intermediates/data/queries');
  let current = initial;
  dependencies.getIntermediatesOperation.mockImplementation(() => Promise.resolve(current));
  return async (next: IntermediatesOperation) => {
    current = next;
    await act(() => {
      queryClient.setQueryData(intermediatesOperationQueryOptions(next.operationId).queryKey, next);
    });
  };
};

/** Delete stays focusable while unavailable, so the reason it waits can be announced. */
const isDeleteUnavailable = (): boolean =>
  buttonWithText('intermediates.list.delete', host).getAttribute('aria-disabled') === 'true';

const setInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const openDialog = async (): Promise<HTMLElement> => {
  await act(() => buttonWithText('intermediates.list.delete', host).click());
  const dialog = await vi.waitFor(() => {
    const element = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(element).not.toBeNull();
    return element!;
  });
  await vi.waitFor(() => expect(dialog.textContent).toContain('intermediates.dialog.reclaim'));
  return dialog;
};

const openForceDialogReadyToConfirm = async (
  options: { canClearOthersIntermediates?: boolean } = {}
): Promise<HTMLElement> => {
  await renderManager({ focusProjectId: 'p1', ...options });
  await vi.waitFor(() => expect(host.textContent).toContain('Portraits'));
  const dialog = await openDialog();
  const toggles = () => [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  await act(() => toggles()[0]!.click());
  await vi.waitFor(() => expect(dialog.textContent).toContain('intermediates.dialog.affectedClientState'));
  await act(() => toggles()[1]!.click());
  await act(() => setInputValue(dialog.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!, 'DELETE'));
  return dialog;
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
    dependencies.listIntermediatesOperations.mockReset().mockResolvedValue([]);
  });

  afterEach(async () => {
    // A confirmation torn down while open restores focus later, into the next test; close it first.
    const cancel = document.querySelector<HTMLButtonElement>('[role="alertdialog"] button:not([disabled])');
    if (cancel && cancel.textContent?.includes('common.cancel')) {
      await act(() => cancel.click());
      await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    }
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

  it('identifies the account in repeated admin row selections', async () => {
    dependencies.getIntermediatesSummary.mockImplementation((params: { ownerId: string | null }) =>
      Promise.resolve(
        summaryOf(
          params.ownerId
            ? [row(null, null, 1)]
            : [
                row(null, null, 1),
                { ...row(null, null, 1), userDisplayName: 'Alice', userEmail: 'bob@example.com', userId: 'bob' },
              ]
        )
      )
    );
    await renderManager({ canClearOthersIntermediates: true });
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="intermediates.owner.showEveryone"]')!.click());
    await vi.waitFor(() => expect(host.querySelectorAll('[role="list"] li')).toHaveLength(2));

    const names = [...host.querySelectorAll('[role="list"] li [aria-label]')].map((element) =>
      element.getAttribute('aria-label')
    );
    expect(names).toEqual([
      'intermediates.list.selectRowForOwner(name=intermediates.list.unassigned,owner=intermediates.owner.nameWithEmail(email=alice@example.com,name=Alice))',
      'intermediates.list.selectRowForOwner(name=intermediates.list.unassigned,owner=intermediates.owner.nameWithEmail(email=bob@example.com,name=Alice))',
    ]);
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
    // The focused project is the whole filtered list, so the first click clears; the second selects all matching.
    await act(() => checkbox('intermediates.list.selectAll').click());
    expect(isDeleteUnavailable()).toBe(true);
    await act(() => checkbox('intermediates.list.selectAll').click());
    await act(() => buttonWithText('intermediates.list.delete', host).click());
    await vi.waitFor(() =>
      expect(dependencies.createIntermediatesPreview).toHaveBeenCalledWith(
        { mode: 'safe', scope: matchingScope({ projectId: 'p1' }) },
        expect.anything()
      )
    );
  });

  it('moves focus to the started operation, whose status the Delete control no longer reflects', async () => {
    await renderManager({ focusProjectId: 'p1' });
    await vi.waitFor(() => expect(host.textContent).toContain('Portraits'));
    const dialog = await openDialog();
    await act(() => buttonWithText('intermediates.dialog.confirm', dialog).click());
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    await vi.waitFor(
      () => {
        const focused = document.activeElement as HTMLElement;
        expect(focused.getAttribute('tabindex')).toBe('-1');
        expect(focused.textContent).toContain('intermediates.operation.status.running');
      },
      { timeout: 3_000 }
    );
  });

  it.each([
    ['its rows', { currentUserId: 'alice' }, 'Alice'],
    ['the entry point', { currentUserId: 'alice', focusOwner: { ownerId: 'bob-3f1c9a7e', ownerLabel: 'Bob' } }, 'Bob'],
    ['the signed-in account', { currentUserId: 'carol-5d2e8b10', currentUserLabel: 'Carol' }, 'Carol'],
    ['nothing', { currentUserId: 'dave-9a0b1c2d' }, 'intermediates.owner.unknownAccount'],
  ] as const)('names the account filter from %s without showing its id', async (_source, options, name) => {
    if (name !== 'Alice') {
      dependencies.getIntermediatesSummary.mockReset().mockResolvedValue(summaryOf([]));
    }
    await renderManager({ canClearOthersIntermediates: true, ...options });
    await vi.waitFor(() => expect(host.textContent).toContain(`intermediates.owner.filtered(name=${name})`));
    const ownerId = 'focusOwner' in options ? options.focusOwner.ownerId : options.currentUserId;
    expect(host.textContent).not.toContain(ownerId);
  });

  it('tells apart rows of accounts that have neither a name nor an email', async () => {
    const anonymous = (userId: string): IntermediatesRow => ({
      ...row(null, null, 1),
      userDisplayName: null,
      userEmail: null,
      userId,
    });
    dependencies.getIntermediatesSummary
      .mockReset()
      .mockResolvedValue(summaryOf([anonymous('0a1b2c3d-first'), anonymous('9f8e7d6c-second')]));
    await renderManager({ canClearOthersIntermediates: true });
    const showEveryone = await vi.waitFor(() => {
      const button = host.querySelector<HTMLButtonElement>('button[aria-label="intermediates.owner.showEveryone"]');
      expect(button).not.toBeNull();
      return button!;
    });
    await act(() => showEveryone.click());
    const labels = await vi.waitFor(() => {
      const found = [...host.querySelectorAll('[role="list"] [aria-label]')].map((node) =>
        node.getAttribute('aria-label')
      );
      expect(found).toHaveLength(2);
      return found;
    });
    expect(new Set(labels).size).toBe(2);
    expect(labels[0]).toContain('intermediates.owner.unknownAccountWithId(id=0a1b2c3d)');
  });

  it('re-follows a running operation after a reload by asking the server', async () => {
    const { activeOperationStore } = await import('@features/intermediates/data/operationStore');
    const running = { ...operationOf('running'), operationId: 'op-running' };
    dependencies.listIntermediatesOperations.mockResolvedValue([
      running,
      { ...operationOf('completed'), operationId: 'op-0' },
    ]);
    dependencies.getIntermediatesOperation.mockResolvedValue(running);

    await renderManager();
    await vi.waitFor(() => expect(host.textContent).toContain('intermediates.operation.status.running'));
    expect(activeOperationStore.getSnapshot().operationId).toBe('op-running');
    expect(dependencies.listIntermediatesOperations).toHaveBeenCalledOnce();
    expect(dependencies.startIntermediatesOperation).not.toHaveBeenCalled();
  });

  it('does not let a late operations listing replace a newer confirmed operation', async () => {
    const { activeOperationStore } = await import('@features/intermediates/data/operationStore');
    let resolveListing!: (operations: IntermediatesOperation[]) => void;
    dependencies.listIntermediatesOperations.mockImplementation(
      () =>
        new Promise<IntermediatesOperation[]>((resolve) => {
          resolveListing = resolve;
        })
    );
    dependencies.startIntermediatesOperation.mockResolvedValue({ ...operationOf('running'), operationId: 'new-op' });
    await renderManager({ focusProjectId: 'p1' });
    await vi.waitFor(() => expect(dependencies.listIntermediatesOperations).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(host.textContent).toContain('Portraits'));
    const dialog = await openDialog();
    await act(() => buttonWithText('intermediates.dialog.confirm', dialog).click());
    await vi.waitFor(() => expect(activeOperationStore.getSnapshot().operationId).toBe('new-op'));

    await act(() => resolveListing([{ ...operationOf('running'), operationId: 'old-op' }]));
    expect(activeOperationStore.getSnapshot().operationId).toBe('new-op');
  });

  it('re-enables Confirm and follows nothing when sign-out cuts a start off', async () => {
    const { activeOperationStore } = await import('@features/intermediates/data/operationStore');
    accountLifecycle.activate('alice');
    try {
      dependencies.startIntermediatesOperation.mockImplementation(
        (_request: unknown, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          })
      );
      const dialog = await openForceDialogReadyToConfirm();
      await act(() => buttonWithText('intermediates.dialog.forceConfirm', dialog).click());
      await vi.waitFor(() => expect(buttonWithText('intermediates.dialog.forceConfirm', dialog).disabled).toBe(true));

      await act(() => {
        accountLifecycle.activate('mallory');
      });
      await vi.waitFor(() => expect(buttonWithText('intermediates.dialog.forceConfirm', dialog).disabled).toBe(false));
      expect(activeOperationStore.getSnapshot().operationId).toBeNull();
    } finally {
      accountLifecycle.invalidate();
    }
  });

  it.each(['running', 'completed'] as const)(
    'follows the %s run the server lists when a start timed out',
    async (status) => {
      // The mount listing answers before the start; a small cleanup may even finish before the fresh listing.
      const accepted = { ...operationOf(status), operationId: 'op-accepted' };
      dependencies.startIntermediatesOperation.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
      dependencies.listIntermediatesOperations.mockImplementation(() =>
        Promise.resolve(dependencies.startIntermediatesOperation.mock.calls.length > 0 ? [accepted] : [])
      );
      dependencies.getIntermediatesOperation.mockResolvedValue(accepted);
      const dialog = await openForceDialogReadyToConfirm();

      await act(() => buttonWithText('intermediates.dialog.forceConfirm', dialog).click());

      await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
      await vi.waitFor(() => expect(host.textContent).toContain(`intermediates.operation.status.${status}`));
      expect(dependencies.startIntermediatesOperation).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect((document.activeElement as HTMLElement).getAttribute('tabindex')).toBe('-1'), {
        timeout: 3_000,
      });
    }
  );

  it('explains a timed-out start that the server does not list and lets Confirm try again', async () => {
    dependencies.startIntermediatesOperation.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    const dialog = await openForceDialogReadyToConfirm();
    await act(() => buttonWithText('intermediates.dialog.forceConfirm', dialog).click());
    await vi.waitFor(() => expect(dialog.textContent).toContain('intermediates.dialog.startTimedOut'));
    const confirm = buttonWithText('intermediates.dialog.forceConfirm', dialog);
    expect(confirm.disabled).toBe(false);

    await act(() => confirm.click());
    await vi.waitFor(() => expect(dependencies.startIntermediatesOperation).toHaveBeenCalledTimes(2));
    const [first, second] = dependencies.startIntermediatesOperation.mock.calls;
    expect(second![0]).toEqual(first![0]);
    expect(first![0]).toEqual({ previewId: 'preview-force' });
  });

  it('picks up a running operation on Refresh when nothing is followed', async () => {
    const running = { ...operationOf('running'), operationId: 'op-elsewhere' };
    dependencies.listIntermediatesOperations.mockResolvedValueOnce([]).mockResolvedValue([running]);
    dependencies.getIntermediatesOperation.mockResolvedValue(running);
    await renderManager();
    await vi.waitFor(() => expect(host.textContent).toContain('Portraits'));
    expect(host.textContent).not.toContain('intermediates.operation.status.running');

    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="intermediates.refresh"]')!.click());

    await vi.waitFor(() => expect(host.textContent).toContain('intermediates.operation.status.running'));
    expect(dependencies.listIntermediatesOperations).toHaveBeenCalledTimes(2);
  });

  it('never mistakes an earlier finished run for a timed-out start', async () => {
    const { activeOperationStore } = await import('@features/intermediates/data/operationStore');
    // Retained on the server from before this preview (its created_at is older than the preview's).
    const earlier = { ...operationOf('completed'), createdAt: '2026-09-24T11:00:00.000Z', operationId: 'op-earlier' };
    dependencies.listIntermediatesOperations.mockResolvedValue([earlier]);
    dependencies.startIntermediatesOperation.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    const dialog = await openForceDialogReadyToConfirm();
    // The catch-up on open ignores a settled run; Dismiss-then-Confirm leaves nothing followed.
    expect(activeOperationStore.getSnapshot().operationId).toBeNull();

    await act(() => buttonWithText('intermediates.dialog.forceConfirm', dialog).click());

    await vi.waitFor(() => expect(dialog.textContent).toContain('intermediates.dialog.startTimedOut'));
    expect(activeOperationStore.getSnapshot().operationId).toBeNull();
    expect(host.textContent).not.toContain('intermediates.operation.status.completed');
  });

  it('asks the server afresh after a timed-out start, and says so when that fails too', async () => {
    let resolveMountListing!: (operations: IntermediatesOperation[]) => void;
    dependencies.listIntermediatesOperations
      .mockImplementationOnce(
        () =>
          new Promise<IntermediatesOperation[]>((resolve) => {
            resolveMountListing = resolve;
          })
      )
      .mockRejectedValue(new ApiError('Gateway timeout', 504));
    dependencies.startIntermediatesOperation.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    const dialog = await openForceDialogReadyToConfirm();
    await vi.waitFor(() => expect(dependencies.listIntermediatesOperations).toHaveBeenCalledOnce());

    await act(() => buttonWithText('intermediates.dialog.forceConfirm', dialog).click());

    // The listing begun at mount is still pending and could not know about this start: a second one is made.
    await vi.waitFor(() => expect(dependencies.listIntermediatesOperations).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(dialog.textContent).toContain('intermediates.dialog.startUnknown'));
    expect(dialog.textContent).not.toContain('intermediates.dialog.startTimedOut');
    expect(buttonWithText('common.cancel', dialog).disabled).toBe(false);
    await act(() => resolveMountListing([]));
  });

  it('offers a fresh check when the confirmed preview is no longer known', async () => {
    dependencies.startIntermediatesOperation.mockRejectedValueOnce(new ApiError('Preview expired or unknown', 404));
    await renderManager({ focusProjectId: 'p1' });
    await vi.waitFor(() => expect(host.textContent).toContain('Portraits'));
    const dialog = await openDialog();

    await act(() => buttonWithText('intermediates.dialog.confirm', dialog).click());

    await vi.waitFor(() => expect(dialog.textContent).toContain('intermediates.dialog.previewExpired'));
    expect(buttonWithText('intermediates.dialog.confirm', dialog).disabled).toBe(true);
    await act(() => buttonWithText('common.retry', dialog).click());
    await vi.waitFor(() => expect(dialog.textContent).toContain('intermediates.dialog.reclaim'));
    expect(buttonWithText('intermediates.dialog.confirm', dialog).disabled).toBe(false);
    expect(dependencies.createIntermediatesPreview).toHaveBeenCalledTimes(2);
  });

  it('names the owner of another account’s affected documents for an administrator', async () => {
    const dialog = await openForceDialogReadyToConfirm({ canClearOthersIntermediates: true });
    const items = [...dialog.querySelectorAll('li')].map((item) => item.textContent ?? '');
    expect(items.filter((text) => text.includes('affectedOwner'))).toEqual([
      expect.stringContaining('intermediates.dialog.affectedOwner(owner=Bob)'),
    ]);
    expect(dialog.textContent).toContain('intermediates.dialog.forceWarning');
    expect(dialog.textContent).not.toContain('intermediates.dialog.forceWarningOwn');
  });

  it('counts the affected documents the server left out of the list', async () => {
    dependencies.createIntermediatesPreview.mockImplementation(({ mode }: { mode: 'safe' | 'force' }) =>
      Promise.resolve({ ...previewOf(mode, 4), affectedDocumentsTotal: mode === 'force' ? 204 : 0 })
    );
    const dialog = await openForceDialogReadyToConfirm();
    const items = [...dialog.querySelectorAll('li')].map((item) => item.textContent ?? '');
    expect(items).toHaveLength(forceAffectedDocuments.length + 1);
    expect(items.at(-1)).toBe('intermediates.dialog.affectedMore(count=200)');
  });

  it('reports a failed start in the dialog and follows nothing', async () => {
    const { activeOperationStore } = await import('@features/intermediates/data/operationStore');
    const dialog = await openForceDialogReadyToConfirm();
    expect(dialog.textContent).toContain('intermediates.dialog.affectedQuarantinedProject(count=1,name=Old sketch)');
    expect(dialog.textContent).toContain('intermediates.dialog.forceWarningOwn');
    dependencies.startIntermediatesOperation.mockRejectedValueOnce(new ApiError('Server error', 500));

    await act(() => buttonWithText('intermediates.dialog.forceConfirm', dialog).click());

    await vi.waitFor(() => expect(dialog.textContent).toContain('Server error'));
    expect(buttonWithText('intermediates.dialog.forceConfirm', dialog).disabled).toBe(false);
    expect(activeOperationStore.getSnapshot().operationId).toBeNull();
  });

  it('lists projects with used and unused counts and keeps Delete disabled until something is selected', async () => {
    await renderManager();
    await vi.waitFor(() => expect(host.textContent).toContain('Portraits'));

    expect(host.textContent).toContain('intermediates.list.unassigned');
    expect(host.querySelectorAll('[role="list"] li')).toHaveLength(3);
    expect(host.textContent).toContain('intermediates.list.used');
    expect(host.textContent).toContain('intermediates.list.unused');
    expect(isDeleteUnavailable()).toBe(true);
    await act(() => buttonWithText('intermediates.list.delete', host).click());
    expect(dependencies.createIntermediatesPreview).not.toHaveBeenCalled();

    await act(() => checkbox('intermediates.list.selectRow(name=Portraits)').click());
    expect(isDeleteUnavailable()).toBe(false);
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
    expect(isDeleteUnavailable()).toBe(true);
  });

  it('refreshes measured sizes while an open summary is still being measured', async () => {
    const initial = summaryOf([{ ...row('p1', 'Portraits', 1), reclaimableBytes: 0, unknownSizeCount: 1 }]);
    initial.measuring = true;
    initial.totals.reclaimableBytes = 0;
    initial.totals.unknownSizeCount = 1;
    const measured = summaryOf([row('p1', 'Portraits', 1)]);
    dependencies.getIntermediatesSummary.mockImplementationOnce(() => Promise.resolve(initial));
    dependencies.getIntermediatesSummary.mockImplementation(() => Promise.resolve(measured));

    await renderManager();
    await vi.waitFor(() => expect(host.textContent).toContain('intermediates.list.unmeasured(count=1)'));
    await act(() => host.querySelector<HTMLButtonElement>('[role="list"] li [aria-label]')!.click());
    expect(host.textContent).toContain('intermediates.selection.estimate');
    await vi.waitFor(
      () => {
        expect(dependencies.getIntermediatesSummary.mock.calls.length).toBeGreaterThan(1);
        expect(host.textContent).toContain('1.0 MB');
        expect(host.textContent).toContain('size=1.0 MB');
        expect(host.querySelector('[aria-label="intermediates.stats.measuringNote"]')).toBeNull();
      },
      { timeout: 8_000 }
    );
  }, 10_000);

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
    await vi.waitFor(() => expect(dialog!.textContent).toContain('intermediates.dialog.reclaim(size=4.2 MB)'));
    expect(dialog!.textContent).toContain('intermediates.dialog.kept(count=3)');
    // The impact is the dialog's accessible description even though it arrives after the dialog opens.
    const describedBy = dialog!.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy!)?.textContent).toContain('intermediates.dialog.reclaim(size=4.2 MB)');

    const confirm = buttonWithText('intermediates.dialog.confirm', dialog!);
    expect(confirm.disabled).toBe(false);
    await act(() => confirm.click());
    await vi.waitFor(() =>
      expect(dependencies.startIntermediatesOperation).toHaveBeenCalledWith(
        { previewId: 'preview-safe' },
        expect.anything()
      )
    );
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    expect(host.textContent).toContain('intermediates.operation.status.running');
    await vi.waitFor(() => expect(host.textContent).toContain('intermediates.operation.status.completed'), {
      timeout: 5_000,
    });
    expect(host.textContent).not.toContain('intermediates.operation.runAgain');
  });

  it('gates a force delete behind the disclosure, an acknowledgement and the typed word', async () => {
    await renderManager({ focusProjectId: 'p1' });
    await vi.waitFor(() => expect(host.textContent).toContain('Portraits'));
    const dialog = await openDialog();
    expect(dialog.textContent).toContain('intermediates.dialog.keptReferenced');

    const toggles = () => [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    await act(() => toggles()[0]!.click());
    await vi.waitFor(() =>
      expect(dependencies.createIntermediatesPreview).toHaveBeenLastCalledWith(
        expect.objectContaining({ mode: 'force' }),
        expect.anything()
      )
    );
    await vi.waitFor(() => expect(dialog.textContent).toContain('Portraits'));
    // Force mode keeps nothing for being referenced, so that reason is not listed at zero.
    expect(dialog.textContent).not.toContain('intermediates.dialog.keptReferenced');
    expect(dialog.textContent).toContain('intermediates.dialog.keptActive');
    const confirm = () => buttonWithText('intermediates.dialog.forceConfirm', dialog);
    expect(confirm().disabled).toBe(true);

    await act(() => toggles()[1]!.click());
    expect(confirm().disabled).toBe(true);

    const typed = dialog.querySelector<HTMLInputElement>('input:not([type="checkbox"])');
    expect(typed).not.toBeNull();
    await act(() => setInputValue(typed!, 'DELETE'));
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

  it('shows a rejected preview with the server’s reason and a retry', async () => {
    dependencies.createIntermediatesPreview
      .mockRejectedValueOnce(new ApiError('Too many documents would break; narrow the scope', 422))
      .mockImplementation(({ mode }: { mode: 'safe' | 'force' }) => Promise.resolve(previewOf(mode, 4)));
    await renderManager({ focusProjectId: 'p1' });
    await vi.waitFor(() => expect(host.textContent).toContain('Portraits'));
    await act(() => buttonWithText('intermediates.list.delete', host).click());
    const dialog = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('[role="alertdialog"]');
      expect(element).not.toBeNull();
      return element!;
    });
    await vi.waitFor(() => expect(dialog.textContent).toContain('Too many documents would break; narrow the scope'));
    expect(
      [...dialog.querySelectorAll('button')].some(
        (button) => button.textContent?.includes('intermediates.dialog.confirm') && !button.disabled
      )
    ).toBe(false);

    await act(() => buttonWithText('common.retry', dialog).click());
    await vi.waitFor(() => expect(dialog.textContent).toContain('intermediates.dialog.reclaim'));
  });

  it('preselects the requested project in single-user mode, where the session names no account', async () => {
    await renderManager({ currentUserId: null, focusProjectId: 'p2' });
    await vi.waitFor(() => expect(host.textContent).toContain('Landscapes'));

    expect(checkbox('intermediates.list.selectRow(name=Landscapes)').checked).toBe(true);
    expect(checkbox('intermediates.list.selectRow(name=Portraits)').checked).toBe(false);
    expect(isDeleteUnavailable()).toBe(false);
    expect(host.textContent).toContain('count=1');
  });

  it('keeps the current rows visible but inert while the next page or a new search loads', async () => {
    const manyRows = Array.from({ length: 60 }, (_, index) => row(`p${index}`, `Project ${index}`, 1));
    let releaseNextPage!: () => void;
    const nextPageGate = new Promise<void>((resolve) => {
      releaseNextPage = resolve;
    });
    let releaseSearch!: () => void;
    const searchGate = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    dependencies.getIntermediatesSummary
      .mockReset()
      .mockImplementation(async (params: { offset?: number; search?: string }) => {
        const offset = params.offset ?? 0;
        if (params.search?.trim()) {
          await searchGate;
          return summaryOf([row('p1', 'Project 1', 1)]);
        }
        if (offset > 0) {
          await nextPageGate;
        }
        return { ...summaryOf(manyRows.slice(offset, offset + 50)), offset, total: manyRows.length };
      });
    await renderManager();
    await vi.waitFor(() => expect(host.textContent).toContain('Project 0'));

    await act(() => buttonWithText('common.nextPage', host).click());
    const list = host.querySelector('[role="list"]')!;
    await vi.waitFor(() => expect(list.getAttribute('aria-busy')).toBe('true'));
    expect(host.textContent).toContain('Project 0');
    expect(host.textContent).toContain('common.pageNumber(page=1)');
    const staleRow = host
      .querySelector('[aria-label="intermediates.list.selectRow(name=Project 0)"]')!
      .querySelector<HTMLInputElement>('input')!;
    expect(staleRow.disabled).toBe(true);
    expect(checkbox('intermediates.list.selectAll').checked).toBe(false);
    expect(host.querySelector('[aria-label="intermediates.list.selectAll"]')!.querySelector('input')!.disabled).toBe(
      true
    );

    await act(() => releaseNextPage());
    await vi.waitFor(() => expect(host.textContent).toContain('Project 55'));
    expect(host.querySelector('[role="list"]')!.getAttribute('aria-busy')).toBeNull();
    expect(host.textContent).toContain('common.pageNumber(page=2)');

    await act(() =>
      setInputValue(host.querySelector<HTMLInputElement>('input[aria-label="intermediates.searchLabel"]')!, 'one')
    );
    await vi.waitFor(() =>
      expect(dependencies.getIntermediatesSummary).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'one' }),
        expect.anything()
      )
    );
    expect(host.textContent).toContain('Project 55');
    expect(host.querySelector('[role="list"]')!.getAttribute('aria-busy')).toBe('true');
    await act(() => releaseSearch());
    await vi.waitFor(() => expect(host.textContent).not.toContain('Project 55'));
    expect(host.textContent).toContain('Project 1');
    expect(host.querySelector('[role="list"]')!.getAttribute('aria-busy')).toBeNull();
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

  it('keeps all 119 other projects selected across pages and sends the exclusion, not the rows', async () => {
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
    const scope = matchingScope({ excluded: [{ projectId: 'p1', userId: 'alice' }] });
    await vi.waitFor(() =>
      expect(dependencies.createIntermediatesPreview).toHaveBeenLastCalledWith(
        { mode: 'safe', scope },
        expect.anything()
      )
    );
    await act(() => document.querySelector<HTMLLabelElement>('[role="alertdialog"] label')!.click());
    await vi.waitFor(() =>
      expect(dependencies.createIntermediatesPreview).toHaveBeenLastCalledWith(
        { mode: 'force', scope },
        expect.anything()
      )
    );
    expect(dependencies.getIntermediatesSummary.mock.calls.every(([params]) => (params.limit ?? 50) <= 50)).toBe(true);
  });

  it('shows a restored operation lookup failure and retries the lookup without starting cleanup', async () => {
    const { followIntermediatesOperation } = await import('@features/intermediates/data/operationStore');
    followIntermediatesOperation('op-1');
    dependencies.getIntermediatesOperation.mockRejectedValue(new ApiError('Status temporarily unavailable', 503));
    await renderManager();
    await vi.waitFor(() => expect(host.textContent).toContain('intermediates.operation.lookupFailed'), {
      timeout: 4000,
    });
    expect(host.textContent).toContain('Status temporarily unavailable');
    await page.screenshot({ path: '../../../../artifacts/intermediates/operation-lookup-error.png' });
    dependencies.getIntermediatesOperation.mockResolvedValue(operationOf('completed'));
    await act(() => buttonWithText('common.retry', host).click());
    await vi.waitFor(() => expect(host.textContent).toContain('intermediates.operation.status.completed'));
    expect(dependencies.startIntermediatesOperation).not.toHaveBeenCalled();
    // Something was followed, so the server was not asked for the account's operations.
    expect(dependencies.listIntermediatesOperations).not.toHaveBeenCalled();
  });

  it('stops polling an operation the server no longer knows and lets it be dismissed', async () => {
    const { followIntermediatesOperation, activeOperationStore } =
      await import('@features/intermediates/data/operationStore');
    followIntermediatesOperation('missing');
    dependencies.getIntermediatesOperation.mockRejectedValue(new ApiError('Operation not found', 404));
    await renderManager();
    await vi.waitFor(() => expect(host.textContent).toContain('intermediates.operation.lookupGone'));
    const calls = dependencies.getIntermediatesOperation.mock.calls.length;
    await new Promise((resolve) => {
      setTimeout(resolve, 2200);
    });
    expect(dependencies.getIntermediatesOperation).toHaveBeenCalledTimes(calls);
    await act(() => buttonWithText('intermediates.operation.dismiss', host).click());
    expect(activeOperationStore.getSnapshot().operationId).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[aria-label="intermediates.searchLabel"]'));
  });

  it('estimates all-matching from the totals minus the excluded rows, refreshed from the visible page', async () => {
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
    await act(() => buttonWithText('common.nextPage', host).click());
    await vi.waitFor(() => expect(host.textContent).toContain('Project 55'));

    // The excluded row vanished off-page: the estimate never drops below what is visibly selected.
    currentRows = [row('p55', 'Project 55', 1)];
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label="intermediates.refresh"]')!.click());
    await vi.waitFor(() => expect(host.textContent).toContain('intermediates.selection.estimate(count=1,'));
    expect(checkbox('intermediates.list.selectRow(name=Project 55)').checked).toBe(true);
    expect(isDeleteUnavailable()).toBe(false);

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
        { mode: 'safe', scope: matchingScope({ excluded: [{ projectId: 'p1', userId: 'alice' }] }) },
        expect.anything()
      )
    );
  });

  it('debounces search into one request while keeping the input responsive', async () => {
    await renderManager();
    await vi.waitFor(() => expect(host.textContent).toContain('Portraits'));
    const search = page.getByRole('textbox', { name: 'intermediates.searchLabel' });
    const input = search.element() as HTMLInputElement;
    const before = dependencies.getIntermediatesSummary.mock.calls.length;

    for (const value of ['P', 'Po', 'Por', 'Port']) {
      await act(() => setInputValue(input, value));
    }
    expect(input.value).toBe('Port');
    expect(host.querySelector('[role="list"]')!.getAttribute('aria-busy')).toBe('true');
    await vi.waitFor(() => expect(host.querySelectorAll('[role="list"] li')).toHaveLength(1));
    const searches = dependencies.getIntermediatesSummary.mock.calls
      .slice(before)
      .map(([params]) => (params as { search?: string }).search);
    expect(searches).toEqual(['Port']);
  });

  it('sends Select all under a search as a matching scope with its exclusions and no full read', async () => {
    const manyRows = Array.from({ length: 60 }, (_, index) => row(`p${index}`, `Match ${index}`, 1));
    dependencies.getIntermediatesSummary
      .mockReset()
      .mockImplementation((params: { offset?: number; limit?: number; search?: string }) => {
        const matching = params.search?.trim() ? manyRows : [...manyRows, row('other', 'Other', 1)];
        const offset = params.offset ?? 0;
        return Promise.resolve({
          ...summaryOf(matching),
          items: matching.slice(offset, offset + (params.limit ?? 50)),
          offset,
        });
      });
    await renderManager();
    await vi.waitFor(() => expect(host.textContent).toContain('Match 0'));
    await act(() =>
      setInputValue(
        page.getByRole('textbox', { name: 'intermediates.searchLabel' }).element() as HTMLInputElement,
        'Match'
      )
    );
    await vi.waitFor(() => expect(host.textContent).not.toContain('Other'));
    await vi.waitFor(() => expect(host.querySelector('[role="list"]')!.getAttribute('aria-busy')).toBeNull());
    await act(() => checkbox('intermediates.list.selectAll').click());
    await act(() => checkbox('intermediates.list.selectRow(name=Match 3)').click());
    await vi.waitFor(() => expect(host.textContent).toContain('count=59'));
    await act(() => buttonWithText('intermediates.list.delete', host).click());

    await vi.waitFor(() =>
      expect(dependencies.createIntermediatesPreview).toHaveBeenCalledWith(
        { mode: 'safe', scope: matchingScope({ excluded: [{ projectId: 'p3', userId: 'alice' }], search: 'Match' }) },
        expect.anything()
      )
    );
    expect(dependencies.getIntermediatesSummary.mock.calls.every(([params]) => (params.limit ?? 50) <= 50)).toBe(true);
  });

  it('keeps keyboard focus on the paging controls while pages load and at the last page', async () => {
    const manyRows = Array.from({ length: 60 }, (_, index) => row(`p${index}`, `Project ${index}`, 1));
    let releaseNextPage!: () => void;
    const nextPageGate = new Promise<void>((resolve) => {
      releaseNextPage = resolve;
    });
    dependencies.getIntermediatesSummary.mockReset().mockImplementation(async (params: { offset?: number }) => {
      const offset = params.offset ?? 0;
      if (offset > 0) {
        await nextPageGate;
      }
      return { ...summaryOf(manyRows.slice(offset, offset + 50)), offset, total: manyRows.length };
    });
    await renderManager();
    await vi.waitFor(() => expect(host.textContent).toContain('Project 0'));
    const next = page.getByRole('button', { name: 'common.nextPage' }).element() as HTMLButtonElement;
    next.focus();
    await act(() => next.click());
    await vi.waitFor(() => expect(next.getAttribute('aria-disabled')).toBe('true'));
    // A second activation while the page loads is ignored instead of skipping a page.
    await act(() => next.click());
    expect(document.activeElement).toBe(next);

    await act(() => releaseNextPage());
    await vi.waitFor(() => expect(host.textContent).toContain('Project 55'));
    expect(host.textContent).toContain('common.pageNumber(page=2)');
    expect(next.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(next);
    expect(
      dependencies.getIntermediatesSummary.mock.calls.filter(
        ([params]) => (params as { offset?: number }).offset === 100
      )
    ).toHaveLength(0);
  });

  it('keeps Refresh focusable while it reloads', async () => {
    let releaseRefresh!: () => void;
    await renderManager();
    await vi.waitFor(() => expect(host.textContent).toContain('Portraits'));
    dependencies.getIntermediatesSummary.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRefresh = () => resolve(summaryOf([row('p1', 'Portraits', 4)]));
        })
    );
    const refresh = page.getByRole('button', { name: 'intermediates.refresh' }).element() as HTMLButtonElement;
    refresh.focus();
    await act(() => refresh.click());
    await vi.waitFor(() => expect(refresh.getAttribute('aria-busy')).toBe('true'));
    expect(refresh.disabled).toBe(false);
    expect(document.activeElement).toBe(refresh);
    await act(() => releaseRefresh());
    await vi.waitFor(() => expect(refresh.getAttribute('aria-busy')).toBeNull());
  });

  it('opens the confirmation on Cancel rather than the force toggle', async () => {
    await renderManager({ focusProjectId: 'p1' });
    await vi.waitFor(() => expect(host.textContent).toContain('Portraits'));
    await act(() => buttonWithText('intermediates.list.delete', host).click());
    const dialog = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('[role="alertdialog"]');
      expect(element).not.toBeNull();
      return element!;
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(buttonWithText('common.cancel', dialog)));
    const description = document.getElementById(dialog.getAttribute('aria-describedby')!)!;
    expect(description.getAttribute('aria-live')).toBe('polite');
    await vi.waitFor(() => expect(description.textContent).toContain('intermediates.dialog.reclaim'));
    expect(description.getAttribute('aria-busy')).toBeNull();
  });

  it('holds Delete, focusable with its reason, until the followed cleanup settles', async () => {
    const { followIntermediatesOperation } = await import('@features/intermediates/data/operationStore');
    followIntermediatesOperation('op-1');
    const publish = await followOperation(operationOf('running'));
    await renderManager({ focusProjectId: 'p1' });
    await vi.waitFor(() => expect(host.textContent).toContain('intermediates.operation.status.running'));
    const deleteButton = buttonWithText('intermediates.list.delete', host);
    expect(isDeleteUnavailable()).toBe(true);
    deleteButton.focus();
    expect(document.activeElement).toBe(deleteButton);
    const reason = document.getElementById(deleteButton.getAttribute('aria-describedby')!);
    expect(reason?.textContent).toBe('intermediates.list.deleteWaiting');
    await act(() => deleteButton.click());
    expect(dependencies.createIntermediatesPreview).not.toHaveBeenCalled();

    await publish(operationOf('completed'));
    expect(host.textContent).toContain('intermediates.operation.status.completed');
    expect(isDeleteUnavailable()).toBe(false);
    expect(deleteButton.hasAttribute('aria-describedby')).toBe(false);
    expect(host.textContent).not.toContain('intermediates.list.deleteWaiting');
  });

  it('offers to delete again after a run that left failures, in the same mode and scope', async () => {
    const { followIntermediatesOperation } = await import('@features/intermediates/data/operationStore');
    followIntermediatesOperation('op-1');
    const failed: IntermediatesOperation = {
      ...operationOf('completed'),
      mode: 'force',
      progress: { ...operationOf('completed').progress, failedImages: 2 },
      scope: matchingScope({ excluded: [{ projectId: 'p2', userId: 'alice' }], search: 'Port' }),
    };
    await followOperation(failed);
    await renderManager();
    await vi.waitFor(() => expect(host.textContent).toContain('intermediates.operation.status.completed'));
    const runAgain = buttonWithText('intermediates.operation.runAgain', host);

    await act(() => runAgain.click());

    await vi.waitFor(() =>
      expect(dependencies.createIntermediatesPreview).toHaveBeenCalledWith(
        { mode: 'force', scope: failed.scope },
        expect.anything()
      )
    );
    const dialog = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('[role="alertdialog"]');
      expect(element).not.toBeNull();
      return element!;
    });
    // A force run repeats as a force preview, behind the same acknowledgement and typed word.
    await vi.waitFor(() => expect(dialog.textContent).toContain('intermediates.dialog.affectedClientState'));
    expect(buttonWithText('intermediates.dialog.forceConfirm', dialog).disabled).toBe(true);
    await act(() => buttonWithText('common.cancel', dialog).click());
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('intermediates.operation.runAgain'), {
      timeout: 3_000,
    });
    expect(host.contains(document.activeElement)).toBe(true);
  });

  it('hides Retry for an operation the server has forgotten and announces the loss', async () => {
    const { followIntermediatesOperation } = await import('@features/intermediates/data/operationStore');
    followIntermediatesOperation('gone');
    dependencies.getIntermediatesOperation.mockRejectedValue(new ApiError('Not found', 404));
    await renderManager();
    await vi.waitFor(() => expect(host.textContent).toContain('intermediates.operation.lookupGone'));
    const region = host.querySelector('[role="status"][aria-live="polite"]');
    await vi.waitFor(() => expect(region?.textContent).toBe('intermediates.operation.lookupGone'));
    const panel = host.querySelector('[role="group"]')!;
    expect([...panel.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'intermediates.operation.dismiss',
    ]);
  });

  it('announces status changes and coarse progress into one live region that mounts empty', async () => {
    const { followIntermediatesOperation } = await import('@features/intermediates/data/operationStore');
    followIntermediatesOperation('op-1');
    const running = (processed: number): IntermediatesOperation => ({
      ...operationOf('running'),
      progress: { ...operationOf('running').progress, deletedImages: processed, processedImages: processed },
      targetImages: 100,
    });
    let resolveFirst!: (operation: IntermediatesOperation) => void;
    const publish = await followOperation(running(10));
    dependencies.getIntermediatesOperation.mockImplementationOnce(
      () =>
        new Promise<IntermediatesOperation>((resolve) => {
          resolveFirst = resolve;
        })
    );
    await renderManager();
    const regions = () => [...host.querySelectorAll('[role="status"][aria-live="polite"]')];
    expect(regions()).toHaveLength(1);
    expect(regions()[0]!.textContent).toBe('');
    expect(host.querySelector('[role="alert"], .chakra-alert__root[aria-live]')).toBeNull();

    await act(() => resolveFirst(running(10)));
    await vi.waitFor(() =>
      expect(regions()[0]!.textContent).toBe(
        'intermediates.operation.progressAnnouncement(percent=0,status=intermediates.operation.status.running)'
      )
    );
    await publish(running(20));
    expect(host.textContent).toContain('intermediates.operation.progress(done=20,total=100)');
    expect(regions()[0]!.textContent).toBe(
      'intermediates.operation.progressAnnouncement(percent=0,status=intermediates.operation.status.running)'
    );
    await publish(running(60));
    expect(regions()[0]!.textContent).toBe(
      'intermediates.operation.progressAnnouncement(percent=0.5,status=intermediates.operation.status.running)'
    );
    await publish({ ...running(100), completedAt: 'later', status: 'completed' });
    expect(regions()).toHaveLength(1);
    expect(regions()[0]!.textContent).toBe('intermediates.operation.status.completed');
  });

  it('asks the server once under StrictMode, follows the running operation and consumes the entry point intent on commit', async () => {
    const { peekIntermediatesFocus } = await import('@features/intermediates/data/focus');
    const running = { ...operationOf('running'), operationId: 'op-running' };
    dependencies.listIntermediatesOperations.mockResolvedValue([running]);
    dependencies.getIntermediatesOperation.mockResolvedValue(running);

    await renderManager({ focusProjectId: 'p2', strict: true });
    await vi.waitFor(() => expect(host.textContent).toContain('intermediates.operation.status.running'));
    expect(dependencies.listIntermediatesOperations).toHaveBeenCalledOnce();
    expect(checkbox('intermediates.list.selectRow(name=Landscapes)').checked).toBe(true);
    expect(peekIntermediatesFocus()).toBeNull();
  });
});
