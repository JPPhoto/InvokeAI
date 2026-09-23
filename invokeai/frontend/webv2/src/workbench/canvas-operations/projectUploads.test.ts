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

  it('does not upload when project creation fails, and allows a later retry', async () => {
    const ensure = vi.fn().mockRejectedValueOnce(new Error('creation failed')).mockResolvedValue(undefined);
    const engine = createEngine(ensure);
    const upload = vi.spyOn(canvasApplicationPort, 'uploadImage').mockResolvedValue({
      height: 8,
      imageName: 'intermediate.png',
      width: 8,
    });
    try {
      await expect(getCanvasOperations(engine).uploadIntermediate(new Blob())).rejects.toThrow('creation failed');
      expect(upload).not.toHaveBeenCalled();
      await getCanvasOperations(engine).uploadIntermediate(new Blob());
      expect(upload).toHaveBeenCalledOnce();
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
