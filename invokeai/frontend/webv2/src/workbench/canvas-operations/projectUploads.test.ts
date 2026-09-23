import { accountLifecycle } from '@platform/state/accountLifecycle';
import { createTestStubRasterBackend } from '@workbench/canvas-engine/render/raster.testStub';
import { createCanvasProjectMutationPort } from '@workbench/canvasProjectMutationPort';
import { createWorkbenchStore } from '@workbench/workbenchStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canvasApplicationPort } from './applicationPort';
import { createCanvasEngine } from './createCanvasEngine';
import { getCanvasOperations } from './operationAccess';

const createEngine = (ensureProjectOnServer: () => Promise<void>) => {
  const store = createWorkbenchStore();
  const projectId = store.getState().activeProjectId;
  return createCanvasEngine({
    backend: createTestStubRasterBackend(),
    ensureProjectOnServer,
    imageResolver: () => Promise.resolve(new Blob()),
    mutationPort: createCanvasProjectMutationPort(store, projectId),
    projectId,
    reportError: () => undefined,
  });
};

beforeEach(() => {
  accountLifecycle.activate('canvas-upload-test');
});
afterEach(() => vi.restoreAllMocks());

describe('project-owned canvas uploads', () => {
  it('waits for project acknowledgement before uploading utility inputs and generation composites', async () => {
    let acknowledge!: () => void;
    const ready = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const engine = createEngine(() => ready);
    const upload = vi.spyOn(canvasApplicationPort, 'uploadImage').mockResolvedValue({
      height: 8,
      imageName: 'intermediate.png',
      width: 8,
    });
    try {
      const utility = getCanvasOperations(engine).uploadIntermediate(new Blob());
      const composite = engine.exports.getCompositeExecutorDeps().uploadImage(new Blob());
      await Promise.resolve();
      expect(upload).not.toHaveBeenCalled();
      acknowledge();
      await Promise.all([utility, composite]);
      expect(upload).toHaveBeenCalledTimes(2);
      for (const [, options] of upload.mock.calls) {
        expect(options).toMatchObject({ isIntermediate: true, projectId: engine.projectId });
      }
    } finally {
      engine.lifecycle.dispose();
    }
  });

  it('uploads without provenance when the server has not accepted the project, and with it once it has', async () => {
    const ensure = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('creation failed'), { reason: 'unsynced' }))
      .mockResolvedValue(undefined);
    const engine = createEngine(ensure);
    const upload = vi.spyOn(canvasApplicationPort, 'uploadImage').mockResolvedValue({
      height: 8,
      imageName: 'intermediate.png',
      width: 8,
    });
    try {
      await getCanvasOperations(engine).uploadIntermediate(new Blob());
      expect(upload.mock.calls[0]![1]).toMatchObject({ isIntermediate: true, projectId: undefined });
      await getCanvasOperations(engine).uploadIntermediate(new Blob());
      expect(upload.mock.calls[1]![1]).toMatchObject({ isIntermediate: true, projectId: engine.projectId });
    } finally {
      engine.lifecycle.dispose();
    }
  });

  it('does not upload for a project that closed while it waited', async () => {
    const engine = createEngine(() =>
      Promise.reject(new DOMException('The canvas project is no longer open.', 'AbortError'))
    );
    const upload = vi.spyOn(canvasApplicationPort, 'uploadImage');
    try {
      await expect(getCanvasOperations(engine).uploadIntermediate(new Blob())).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(upload).not.toHaveBeenCalled();
    } finally {
      engine.lifecycle.dispose();
    }
  });

  it.each(['account change', 'engine disposal', 'operation cancellation'] as const)(
    'does not start a waiting upload after %s',
    async (cancellation) => {
      let acknowledge!: () => void;
      const ready = new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      const engine = createEngine(() => ready);
      const controller = new AbortController();
      const upload = vi.spyOn(canvasApplicationPort, 'uploadImage');
      try {
        const pending = getCanvasOperations(engine).uploadIntermediate(new Blob(), controller.signal);
        const rejected = expect(pending).rejects.toMatchObject({
          name: cancellation === 'account change' ? 'AccountScopeExpiredError' : 'AbortError',
        });
        if (cancellation === 'account change') {
          accountLifecycle.activate('another-account');
        } else if (cancellation === 'engine disposal') {
          engine.lifecycle.dispose();
        } else {
          controller.abort();
        }
        acknowledge();
        await rejected;
        expect(upload).not.toHaveBeenCalled();
      } finally {
        engine.lifecycle.dispose();
      }
    }
  );
});
