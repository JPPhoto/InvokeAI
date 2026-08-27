import type { CanvasDocumentContractV2 } from '@workbench/canvas-engine/contracts';

import { getStackOrder, layerStackOf } from '@workbench/canvas-engine/document/layerStacks';
import { applyCanvasProjectMutation } from '@workbench/canvasProjectMutations';
import { createInitialWorkbenchState } from '@workbench/workbenchState';
import { beforeEach, describe, expect, it } from 'vitest';

import type { FlatDocumentCommand, PreparedFlatEdit } from './flatDocumentCommands';

import { createLargeFlatDocument } from './documentFixtures.testStub';
import {
  compileDocumentLeaves,
  createFlatDocumentModel,
  flatDocumentModelCounters,
  resetLatestLeafCompilation,
} from './flatDocumentModel';
import { ALL_OVERLAY_STACKS_SHOWN, planScreenComposition } from './screenComposition';

const LAYER_COUNT = 2_000;
const context = { editRevision: 0, projectId: 'budget' };

const resetCounters = (): void => {
  flatDocumentModelCounters.indexBuilds = 0;
  flatDocumentModelCounters.leafCompilations = 0;
  flatDocumentModelCounters.leavesCompiled = 0;
};

/** Runs the reducer over a fixture so the next document is the one production consumers see. */
const reduce = (document: CanvasDocumentContractV2, command: FlatDocumentCommand) => {
  const initial = createInitialWorkbenchState().projects[0]!;
  const project = applyCanvasProjectMutation(initial, {
    document,
    type: 'replaceCanvasDocument',
  });
  const accepted = project.canvas.document;
  const model = createFlatDocumentModel(accepted, context);
  const result = model.prepare(command);
  if (result.status !== 'prepared') {
    throw new Error(`expected a prepared edit, got ${result.status}`);
  }
  return { edit: result.edit, model, next: applyCanvasProjectMutation(project, result.edit.forward).canvas.document };
};

type Annotate = (message: string) => unknown;

/** Timing is informational: it is annotated on the test, never asserted. */
const timed = <T>(annotate: Annotate, label: string, run: () => T): T => {
  const start = performance.now();
  const value = run();
  annotate(`${label}: ${(performance.now() - start).toFixed(2)}ms`);
  return value;
};

describe(`flat document model budgets over ${LAYER_COUNT} layers`, () => {
  beforeEach(() => {
    resetLatestLeafCompilation();
    resetCounters();
  });

  it('builds one index per layer array and none for selection-only changes', ({ annotate }) => {
    const project = applyCanvasProjectMutation(createInitialWorkbenchState().projects[0]!, {
      document: createLargeFlatDocument(LAYER_COUNT),
      type: 'replaceCanvasDocument',
    });
    const document = project.canvas.document;
    const model = timed(annotate, 'model construction', () => createFlatDocumentModel(document, context));
    createFlatDocumentModel(document, context);
    model.getLayer('l1999');
    model.getStack('control');
    expect(model.prepare({ id: 'l7', type: 'select' }).status).toBe('prepared');
    expect(model.prepare({ id: 'l0', type: 'select' })).toEqual({ status: 'unchanged' });
    const leaves = compileDocumentLeaves(document);

    const reselected = applyCanvasProjectMutation(project, { id: 'l7', type: 'setCanvasSelectedLayer' }).canvas
      .document;
    expect(reselected).not.toBe(document);
    expect(reselected.selectedLayerId).toBe('l7');
    expect(createFlatDocumentModel(reselected, context, model).compileLeaves()).toBe(leaves);
    expect(compileDocumentLeaves(reselected)).toBe(leaves);
    expect(flatDocumentModelCounters.indexBuilds).toBe(1);
    expect(flatDocumentModelCounters.leafCompilations).toBe(1);
  });

  it('compiles leaves once per document and plans the screen from them', ({ annotate }) => {
    const document = createLargeFlatDocument(LAYER_COUNT);
    const leaves = timed(annotate, 'leaf compilation', () => compileDocumentLeaves(document));
    expect(compileDocumentLeaves(document)).toBe(leaves);
    expect(createFlatDocumentModel(document, context).compileLeaves()).toBe(leaves);
    expect(flatDocumentModelCounters.leafCompilations).toBe(1);
    expect(flatDocumentModelCounters.leavesCompiled).toBe(LAYER_COUNT);

    const plan = timed(annotate, 'screen plan', () =>
      planScreenComposition(leaves, { isolationLayerId: null, showOverlayStacks: ALL_OVERLAY_STACKS_SHOWN })
    );
    expect(plan.leaves).toHaveLength(LAYER_COUNT);
    expect(plan.leaves.at(-1)?.stack).toBe('inpaint_mask');
  });

  it('recompiles only the patched leaf after a reducer edit', ({ annotate }) => {
    const { model, next } = reduce(createLargeFlatDocument(LAYER_COUNT), {
      id: 'l5',
      patch: { opacity: 0.5 },
      type: 'patch',
    });
    const before = model.compileLeaves();
    resetCounters();
    const after = timed(annotate, 'representative edit recompile', () => compileDocumentLeaves(next, model.document));
    expect(flatDocumentModelCounters.leafCompilations).toBe(1);
    expect(flatDocumentModelCounters.leavesCompiled).toBe(1);
    after.forEach((leaf, index) => {
      if (leaf.id === 'l5') {
        expect(leaf).not.toBe(before[index]);
        expect(leaf.layer.opacity).toBe(0.5);
      } else {
        expect(leaf).toBe(before[index]);
      }
    });
  });

  it('reuses the latest compilation when a consumer has no previous document to offer', () => {
    const { model, next } = reduce(createLargeFlatDocument(LAYER_COUNT), {
      id: 'l5',
      patch: { name: 'x' },
      type: 'patch',
    });
    const before = compileDocumentLeaves(model.document);
    resetCounters();
    const after = compileDocumentLeaves(next);
    expect(flatDocumentModelCounters.leavesCompiled).toBe(1);
    expect(after[6]).toBe(before[6]);
  });

  it('recompiles exactly the leaves whose stack position moved', () => {
    const { model, next } = reduce(createLargeFlatDocument(LAYER_COUNT), { ids: ['l0'], kind: 'back', type: 'move' });
    model.compileLeaves();
    resetCounters();
    compileDocumentLeaves(next, model.document);
    const movedStack = layerStackOf(model.getLayer('l0')!);
    expect(flatDocumentModelCounters.leavesCompiled).toBe(getStackOrder(next.layers, movedStack).orderedIds.length);
  });

  it.each<[string, FlatDocumentCommand, { ids: number; stacks: number }]>([
    ['select', { id: 'l9', type: 'select' }, { ids: 0, stacks: 0 }],
    ['lock', { type: 'set-locked', updates: [{ id: 'l1', isLocked: true }] }, { ids: 1, stacks: 1 }],
    [
      'enable',
      {
        type: 'set-enabled',
        updates: Array.from({ length: 10 }, (_, index) => ({ id: `l${index}`, isEnabled: false })),
      },
      { ids: 10, stacks: 4 },
    ],
    ['hide', { type: 'set-hidden', updates: [{ id: 'l1', isHidden: true }] }, { ids: 1, stacks: 1 }],
    ['move', { ids: ['l8', 'l12', 'l16'], kind: 'forward', type: 'move' }, { ids: 4, stacks: 1 }],
    ['remove', { ids: ['l1', 'l2'], type: 'remove' }, { ids: 2, stacks: 2 }],
  ])('prepares a %s edit with exact touched ids and stacks', (_label, command, expected) => {
    const model = createFlatDocumentModel(createLargeFlatDocument(LAYER_COUNT), context);
    const result = model.prepare(command);
    expect(result.status).toBe('prepared');
    const edit = (result as { edit: PreparedFlatEdit }).edit;
    expect(edit.touchedIds).toHaveLength(expected.ids);
    expect(edit.touchedStacks).toHaveLength(expected.stacks);
    expect(flatDocumentModelCounters.indexBuilds).toBe(1);
    expect(flatDocumentModelCounters.leafCompilations).toBe(0);
  });
});
