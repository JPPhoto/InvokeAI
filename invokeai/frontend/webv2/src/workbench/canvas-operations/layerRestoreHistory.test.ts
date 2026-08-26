import type { CanvasLayerContract } from '@workbench/canvas-engine/contracts';

import { haveSameStackOrders } from '@workbench/canvas-engine/api';
import { createTestStubRasterBackend } from '@workbench/canvas-engine/render/raster.testStub';
import { deleteLayerActions, deleteLayersActions } from '@workbench/canvasLayerOps';
import { createEmptyCanvasDocumentV2 } from '@workbench/canvasMigration';
import { createCanvasProjectMutationPort } from '@workbench/canvasProjectMutationPort';
import { createInpaintMaskLayer } from '@workbench/widgets/layers/layerOps';
import { createWorkbenchStore } from '@workbench/workbenchStore';
import { describe, expect, it } from 'vitest';

import { createCanvasEngine } from './createCanvasEngine';

const raster = (id: string): CanvasLayerContract => ({
  blendMode: 'normal',
  id,
  isEnabled: true,
  isLocked: false,
  name: id,
  opacity: 1,
  source: { bitmap: null, type: 'paint' },
  transform: { rotation: 0, scaleX: 1, scaleY: 1, x: 0, y: 0 },
  type: 'raster',
});

const setup = (layers: CanvasLayerContract[], selectedLayerId: string) => {
  const store = createWorkbenchStore();
  const projectId = store.getState().activeProjectId;
  store.commands.canvas.apply(projectId, {
    document: { ...createEmptyCanvasDocumentV2(), layers, selectedLayerId },
    type: 'replaceCanvasDocument',
  });
  const engine = createCanvasEngine({
    backend: createTestStubRasterBackend(),
    imageResolver: () => Promise.resolve(new Blob()),
    mutationPort: createCanvasProjectMutationPort(store, projectId),
    projectId,
    reportError: () => undefined,
  });
  const document = () => store.queries.getProject(projectId)!.canvas.document;
  return { document, engine, original: document() };
};

describe('layer restore through history on an interleaved document', () => {
  it('undoes a delete and then the duplicate that preceded it', async () => {
    const { document, engine, original } = setup(
      [raster('r0'), createInpaintMaskLayer('m1', 'm1'), raster('r1')],
      'r0'
    );
    const duplicated = await engine.layers.duplicateLayers(['r0']);
    expect(duplicated.status).toBe('duplicated');

    const r0 = document().layers.find((layer) => layer.id === 'r0')!;
    const actions = deleteLayerActions(r0, engine.document)!;
    expect(engine.layers.commitStructural('Delete', actions.forward, actions.inverse).status).toBe('committed');
    expect(document().layers.some((layer) => layer.id === 'r0')).toBe(false);

    engine.history.undo();
    expect(document().layers.find((layer) => layer.id === 'r0')).toEqual(r0);

    expect(() => engine.history.undo()).not.toThrow();
    expect(haveSameStackOrders(document().layers, original.layers)).toBe(true);
    expect(document().selectedLayerId).toBe('r0');
    expect(engine.stores.canUndo.get()).toBe(false);
    engine.lifecycle.dispose();
  });

  it('restores a multi-layer delete between the surviving neighbours before undoing the duplicate', async () => {
    const { document, engine, original } = setup(
      [raster('r0'), createInpaintMaskLayer('m1', 'm1'), raster('r1')],
      'r0'
    );
    const duplicated = await engine.layers.duplicateLayers(['r0']);
    if (duplicated.status !== 'duplicated') {
      throw new Error('expected a duplicate');
    }
    const duplicateId = duplicated.duplicateIds[0]!;

    const actions = deleteLayersActions(document().layers, [duplicateId, 'r0'], 'r0', engine.document)!;
    expect(engine.layers.commitStructural('Delete', actions.forward, actions.inverse).status).toBe('committed');
    expect(document().layers.map((layer) => layer.id)).toEqual(['m1', 'r1']);

    engine.history.undo();
    expect(
      document()
        .layers.filter((layer) => layer.type === 'raster')
        .map((layer) => layer.id)
    ).toEqual([duplicateId, 'r0', 'r1']);

    expect(() => engine.history.undo()).not.toThrow();
    expect(haveSameStackOrders(document().layers, original.layers)).toBe(true);
    expect(engine.stores.canUndo.get()).toBe(false);
    engine.lifecycle.dispose();
  });
});
