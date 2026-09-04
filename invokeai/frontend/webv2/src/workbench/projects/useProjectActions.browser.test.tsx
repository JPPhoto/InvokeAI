import type { Project } from '@workbench/projectContracts';

import { accountLifecycle } from '@platform/state/accountLifecycle';
import { createDraftProject } from '@workbench/workbenchState';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import { serializeProjectDocumentV2Json } from './projectDocument';

const harness = vi.hoisted(() => ({
  close: vi.fn<() => { ok: true } | { ok: false; reason: 'last-project' }>(),
  flush: vi.fn(),
  navigate: vi.fn(),
  notifyError: vi.fn(),
  persistEmptySession: vi.fn(),
  project: {} as Project,
  releaseProjectSync: vi.fn(),
}));

vi.mock('@features/generation/react', () => ({ flushGenerateDrafts: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => harness.navigate }));
vi.mock('@workbench/useNotify', () => ({ useNotify: () => ({ error: harness.notifyError }) }));
vi.mock('@workbench/WorkbenchContext', () => ({
  useWorkbenchCommands: () => ({ projects: { close: harness.close } }),
  useWorkbenchPersistenceAdapter: () => ({ getState: () => ({ projects: [harness.project] }) }),
  useWorkbenchPersistenceService: () => ({
    flushProjectToServer: harness.flush,
    persistEmptySession: harness.persistEmptySession,
    releaseProjectSync: harness.releaseProjectSync,
  }),
  useWorkbenchQueries: () => ({
    getProject: () => harness.project,
    getSnapshot: () => ({ projects: [harness.project, createDraftProject([harness.project])] }),
  }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { useProjectActions } from './useProjectActions';

let host: HTMLDivElement | null = null;
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const Harness = () => {
  const { closeProject } = useProjectActions();
  return <button onClick={() => closeProject(harness.project)}>close</button>;
};

beforeEach(() => {
  accountLifecycle.activate('use-project-actions-browser-test');
  harness.project = createDraftProject([]);
  harness.close.mockReset();
  harness.close.mockReturnValue({ ok: true });
  harness.flush.mockReset();
  harness.navigate.mockReset();
  harness.notifyError.mockReset();
  harness.persistEmptySession.mockReset();
  harness.persistEmptySession.mockResolvedValue(undefined);
  harness.releaseProjectSync.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  accountLifecycle.invalidate();
  await act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe('useProjectActions', () => {
  it('reports a rejected close flush and keeps the tab open', async () => {
    harness.flush.mockRejectedValueOnce(new Error('network failed'));
    await act(() => root?.render(<Harness />));

    await act(() => userEvent.click(document.querySelector('button')!));
    await vi.waitFor(() => expect(harness.notifyError).toHaveBeenCalledOnce());

    expect(harness.notifyError).toHaveBeenCalledWith('projects.closeBlocked', 'network failed');
    expect(harness.close).not.toHaveBeenCalled();
  });

  it('reflushes an edit made while close is waiting for acknowledgement', async () => {
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    harness.flush.mockImplementationOnce(async (project: Project) => {
      await firstReleased;
      return { documentJson: serializeProjectDocumentV2Json(project).documentJson, kind: 'acknowledged' as const };
    });
    harness.flush.mockImplementationOnce((project: Project) =>
      Promise.resolve({
        documentJson: serializeProjectDocumentV2Json(project).documentJson,
        kind: 'acknowledged' as const,
      })
    );
    await act(() => root?.render(<Harness />));

    await act(() => userEvent.click(document.querySelector('button')!));
    await vi.waitFor(() => expect(harness.flush).toHaveBeenCalledOnce());
    harness.project = { ...harness.project, name: 'edit during close' };
    releaseFirst();
    await vi.waitFor(() => expect(harness.flush).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledOnce());

    expect(harness.flush.mock.calls[1]![0]).toMatchObject({ name: 'edit during close' });
    expect(harness.releaseProjectSync).toHaveBeenCalledOnce();
  });

  it('keeps the last tab open when its empty session cannot be committed', async () => {
    harness.close.mockReturnValue({ ok: false, reason: 'last-project' });
    harness.flush.mockImplementationOnce((project: Project) =>
      Promise.resolve({
        documentJson: serializeProjectDocumentV2Json(project).documentJson,
        kind: 'acknowledged' as const,
      })
    );
    harness.persistEmptySession.mockRejectedValueOnce(new Error('session offline'));
    await act(() => root?.render(<Harness />));

    await act(() => userEvent.click(document.querySelector('button')!));
    await vi.waitFor(() => expect(harness.notifyError).toHaveBeenCalledOnce());

    expect(harness.notifyError).toHaveBeenCalledWith('projects.closeBlocked', 'session offline');
    expect(harness.releaseProjectSync).not.toHaveBeenCalled();
    expect(harness.navigate).not.toHaveBeenCalled();
  });
});
