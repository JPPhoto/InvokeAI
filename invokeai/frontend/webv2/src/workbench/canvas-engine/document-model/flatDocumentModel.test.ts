import type { CanvasDocumentContractV2, CanvasLayerContract } from '@workbench/canvas-engine/contracts';
import type { Project } from '@workbench/projectContracts';

import { isHideableLayer } from '@workbench/canvas-engine/document/layerEligibility';
import { haveSameStackOrders } from '@workbench/canvas-engine/document/layerStacks';
import { createEmptyCanvasDocumentV2 } from '@workbench/canvasMigration';
import { applyCanvasProjectMutation } from '@workbench/canvasProjectMutations';
import { createInitialWorkbenchState } from '@workbench/workbenchState';
import { describe, expect, it } from 'vitest';

import type { FlatDocumentCommand, PreparedFlatEdit, PrepareFlatEditResult } from './flatDocumentCommands';

import { createFlatDocumentModel, flatDocumentModelCounters } from './flatDocumentModel';
import { checkFlatEditPostconditions } from './postconditions';

const base = (id: string) => ({
  blendMode: 'normal' as const,
  id,
  isEnabled: true,
  isLocked: false,
  name: id,
  opacity: 1,
  transform: { rotation: 0, scaleX: 1, scaleY: 1, x: 0, y: 0 },
});
const mask = { bitmap: null, fill: { color: '#e07575', style: 'diagonal' as const } };
const contract = (id: string, type: CanvasLayerContract['type']): CanvasLayerContract => {
  switch (type) {
    case 'raster':
      return { ...base(id), source: { bitmap: null, type: 'paint' }, type };
    case 'control':
      return {
        ...base(id),
        adapter: { beginEndStepPct: [0, 1], controlMode: 'balanced', kind: 'controlnet', model: null, weight: 1 },
        source: { bitmap: null, type: 'paint' },
        type,
        withTransparencyEffect: false,
      };
    case 'inpaint_mask':
      return { ...base(id), mask, type };
    case 'regional_guidance':
      return {
        ...base(id),
        autoNegative: false,
        mask,
        negativePrompt: null,
        positivePrompt: null,
        referenceImages: [],
        type,
      };
  }
};
const layer = (
  id: string,
  type: CanvasLayerContract['type'] = 'raster',
  overrides: Partial<CanvasLayerContract> = {}
) => ({ ...contract(id, type), ...overrides }) as CanvasLayerContract;

const interleaved = (): CanvasLayerContract[] => [
  layer('i1', 'inpaint_mask'),
  layer('r1'),
  layer('c1', 'control'),
  layer('r2'),
  layer('g1', 'regional_guidance'),
  layer('r3'),
];

const projectWith = (layers: CanvasLayerContract[], selectedLayerId: string | null): Project => {
  const initial = createInitialWorkbenchState().projects[0]!;
  const project = applyCanvasProjectMutation(initial, {
    document: { ...createEmptyCanvasDocumentV2(), layers, selectedLayerId },
    type: 'replaceCanvasDocument',
  });
  if (ids(project.canvas.document).join() !== layers.map((entry) => entry.id).join()) {
    throw new Error('fixture document was not accepted by the reducer');
  }
  return project;
};

const context = (project: Project) => ({ editRevision: 0, projectId: project.id });
const modelOf = (project: Project) => createFlatDocumentModel(project.canvas.document, context(project));

const ids = (document: CanvasDocumentContractV2): string[] => document.layers.map((entry) => entry.id);
const byId = (left: CanvasLayerContract, right: CanvasLayerContract): number => left.id.localeCompare(right.id);
/** The reducer writes an explicit `isHidden: false` on undo where the original layer had no key. */
const withExplicitHidden = (layer: CanvasLayerContract): CanvasLayerContract =>
  isHideableLayer(layer) ? { ...layer, isHidden: layer.isHidden === true } : layer;

const roundTrip = (project: Project, command: FlatDocumentCommand): { after: Project; edit: PreparedFlatEdit } => {
  const result = modelOf(project).prepare(command);
  if (result.status !== 'prepared') {
    throw new Error(`expected a prepared edit, got ${JSON.stringify(result)}`);
  }
  const after = applyCanvasProjectMutation(project, result.edit.forward);
  expect(after.canvas.document).not.toBe(project.canvas.document);
  expect(checkFlatEditPostconditions(after.canvas.document, result.edit.postconditions)).toBe(true);
  expect(after.canvas.document.selectedLayerId).toBe(result.edit.selectionAfter);
  const restored = applyCanvasProjectMutation(after, result.edit.inverse).canvas.document;
  const original = project.canvas.document;
  expect(haveSameStackOrders(restored.layers, original.layers)).toBe(true);
  expect([...restored.layers].sort(byId).map(withExplicitHidden)).toEqual(
    [...original.layers].sort(byId).map(withExplicitHidden)
  );
  expect({ ...restored, layers: [] }).toEqual({ ...original, layers: [] });
  return { after, edit: result.edit };
};

describe('createFlatDocumentModel', () => {
  it('indexes lookup and stack order once per document identity', () => {
    const project = projectWith(interleaved(), 'r2');
    const before = flatDocumentModelCounters.indexBuilds;
    const model = modelOf(project);
    const again = modelOf(project);

    expect(flatDocumentModelCounters.indexBuilds).toBe(before + 1);
    expect(model.getLayer('r2')?.id).toBe('r2');
    expect(model.getLayer('ghost')).toBeNull();
    expect(model.getStack('raster').map((entry) => entry.id)).toEqual(['r1', 'r2', 'r3']);
    expect(again.getStack('raster')).toBe(model.getStack('raster'));
  });

  it('compiles semantic leaves with stack positions and world transforms', () => {
    const project = projectWith(
      [
        layer('i1', 'inpaint_mask', { isHidden: true } as Partial<CanvasLayerContract>),
        layer('r1', 'raster', { isLocked: true }),
      ],
      'r1'
    );
    const leaves = modelOf(project).compileLeaves();

    expect(leaves.map((leaf) => [leaf.id, leaf.stack, leaf.stackIndex])).toEqual([
      ['i1', 'inpaint_mask', 0],
      ['r1', 'raster', 0],
    ]);
    expect(leaves[0]).toMatchObject({ contributionEnabled: true, documentHidden: true, locked: false });
    expect(leaves[1]).toMatchObject({ documentHidden: false, locked: true });
    expect(leaves[1]!.worldTransform).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  });

  it('keeps leaf identity for unaffected layers across an edit and reuses leaves for a selection-only change', () => {
    const project = projectWith(interleaved(), 'r2');
    const first = modelOf(project);
    const leaves = first.compileLeaves();
    const compilations = flatDocumentModelCounters.leafCompilations;
    const compiled = flatDocumentModelCounters.leavesCompiled;

    const selected = applyCanvasProjectMutation(project, { id: 'r1', type: 'setCanvasSelectedLayer' });
    const second = createFlatDocumentModel(selected.canvas.document, context(project), first);
    expect(second.compileLeaves()).toBe(leaves);
    expect(flatDocumentModelCounters.leafCompilations).toBe(compilations);

    const renamed = applyCanvasProjectMutation(selected, {
      id: 'r2',
      patch: { name: 'Renamed' },
      type: 'updateCanvasLayer',
    });
    const third = createFlatDocumentModel(renamed.canvas.document, context(project), second);
    const next = third.compileLeaves();
    expect(flatDocumentModelCounters.leafCompilations).toBe(compilations + 1);
    expect(flatDocumentModelCounters.leavesCompiled).toBe(compiled + 1);
    expect(next.filter((leaf, index) => leaf === leaves[index]).map((leaf) => leaf.id)).toEqual([
      'i1',
      'r1',
      'c1',
      'g1',
      'r3',
    ]);
    expect(next[3]!.layer.name).toBe('Renamed');

    const moved = applyCanvasProjectMutation(renamed, {
      stacks: [{ orderedIds: ['r3', 'r1', 'r2'], stack: 'raster' }],
      type: 'reorderCanvasLayerStacks',
    });
    const fourth = createFlatDocumentModel(moved.canvas.document, context(project), third).compileLeaves();
    expect(fourth.filter((leaf) => next.includes(leaf)).map((leaf) => leaf.id)).toEqual(['i1', 'c1', 'g1']);
  });

  describe('prepare', () => {
    it('inserts above the compatible leaf and restores the previous selection on undo', () => {
      const project = projectWith(interleaved(), 'r2');
      const { after, edit } = roundTrip(project, { aboveId: 'r2', layers: [layer('n1')], type: 'insert' });

      expect(ids(after.canvas.document)).toEqual(['i1', 'r1', 'c1', 'n1', 'r2', 'g1', 'r3']);
      expect(edit).toMatchObject({
        history: 'record',
        postconditions: [
          { kind: 'stack-order', orderedIds: ['r1', 'n1', 'r2', 'r3'], stack: 'raster' },
          { id: 'n1', kind: 'selection' },
        ],
        selectionAfter: 'n1',
        touchedIds: ['n1'],
        touchedStacks: ['raster'],
      });
    });

    it('inserts a foreign-stack layer at its stack top and honours an explicit selection', () => {
      const project = projectWith(interleaved(), 'r2');
      const { after } = roundTrip(project, {
        aboveId: 'r2',
        layers: [layer('m2', 'inpaint_mask')],
        selectId: null,
        type: 'insert',
      });

      expect(ids(after.canvas.document)).toEqual(['m2', 'i1', 'r1', 'c1', 'r2', 'g1', 'r3']);
      expect(after.canvas.document.selectedLayerId).toBeNull();
    });

    it('keeps the given order for several layers whether or not their stacks are empty', () => {
      const populated = roundTrip(projectWith(interleaved(), 'r1'), {
        aboveId: null,
        layers: [layer('a'), layer('b'), layer('m', 'inpaint_mask')],
        type: 'insert',
      });
      expect(ids(populated.after.canvas.document)).toEqual(['m', 'i1', 'a', 'b', 'r1', 'c1', 'r2', 'g1', 'r3']);
      expect(populated.edit.touchedStacks).toEqual(['inpaint_mask', 'raster']);

      const empty = roundTrip(projectWith([layer('c1', 'control')], 'c1'), {
        aboveId: null,
        layers: [layer('a'), layer('b')],
        type: 'insert',
      });
      expect(ids(empty.after.canvas.document)).toEqual(['a', 'b', 'c1']);
    });

    it('removes layers, repairs the selection within the stack, and restores them between their neighbours', () => {
      const project = projectWith(interleaved(), 'r2');
      const { after, edit } = roundTrip(project, { ids: ['r2', 'i1'], type: 'remove' });

      expect(ids(after.canvas.document)).toEqual(['r1', 'c1', 'g1', 'r3']);
      expect(edit).toMatchObject({
        selectionAfter: 'r3',
        touchedIds: ['r2', 'i1'],
        touchedStacks: ['inpaint_mask', 'raster'],
      });
    });

    it('falls back to another stack when the removed primary had no stack neighbour left', () => {
      const project = projectWith(
        [layer('c1', 'control'), layer('r1'), layer('r2'), layer('g1', 'regional_guidance')],
        'r2'
      );
      const { edit } = roundTrip(project, { ids: ['r1', 'r2'], type: 'remove' });
      expect(edit.selectionAfter).toBe('g1');
    });

    it('duplicates above the source and removes the copy on undo', () => {
      const project = projectWith(interleaved(), 'r1');
      const { after, edit } = roundTrip(project, { newId: 'r2-copy', sourceId: 'r2', type: 'duplicate' });

      expect(ids(after.canvas.document)).toEqual(['i1', 'r1', 'c1', 'r2-copy', 'r2', 'g1', 'r3']);
      expect(after.canvas.document.selectedLayerId).toBe('r2-copy');
      expect(edit.postconditions[0]).toEqual({
        kind: 'stack-order',
        orderedIds: ['r1', 'r2-copy', 'r2', 'r3'],
        stack: 'raster',
      });
    });

    it('moves within stacks and reorders several stacks at once', () => {
      const project = projectWith(interleaved(), 'r3');
      const moved = roundTrip(project, { ids: ['r3'], kind: 'front', type: 'move' });
      expect(ids(moved.after.canvas.document)).toEqual(['i1', 'r3', 'c1', 'r1', 'g1', 'r2']);
      expect(moved.edit.touchedIds).toEqual(['r3', 'r1', 'r2']);

      const reordered = roundTrip(project, {
        stacks: [
          { orderedIds: ['r2', 'r1', 'r3'], stack: 'raster' },
          { orderedIds: ['c1'], stack: 'control' },
        ],
        type: 'reorder',
      });
      expect(ids(reordered.after.canvas.document)).toEqual(['i1', 'r2', 'c1', 'r1', 'g1', 'r3']);
      expect(reordered.edit).toMatchObject({ touchedIds: ['r2', 'r1'], touchedStacks: ['control', 'raster'] });
    });

    it('patches base fields and transforms with an exact inverse', () => {
      const project = projectWith(interleaved(), 'r1');
      const { after, edit } = roundTrip(project, {
        id: 'r1',
        patch: { name: 'Renamed', opacity: 0.5, transform: { x: 12 } },
        type: 'patch',
      });

      expect(after.canvas.document.layers[1]).toMatchObject({
        name: 'Renamed',
        opacity: 0.5,
        transform: { x: 12, y: 0 },
      });
      expect(edit.inverse).toEqual({
        id: 'r1',
        patch: { name: 'r1', opacity: 1, transform: { x: 0 } },
        type: 'updateCanvasLayer',
      });
      expect(edit.postconditions).toEqual([
        { id: 'r1', kind: 'patched', patch: { name: 'Renamed', opacity: 0.5, transform: { x: 12 } } },
      ]);
    });

    it('patches locked or disabled layers like the current inputs do and reports a same-value patch as unchanged', () => {
      const project = projectWith([layer('locked', 'raster', { isEnabled: false, isLocked: true })], 'locked');
      const model = modelOf(project);
      expect(model.prepare({ id: 'locked', patch: { name: 'x', opacity: 0.2 }, type: 'patch' }).status).toBe(
        'prepared'
      );
      expect(model.prepare({ id: 'locked', patch: { isEnabled: true, isLocked: false }, type: 'patch' }).status).toBe(
        'prepared'
      );
      expect(model.prepare({ id: 'locked', patch: { transform: { x: 1 } }, type: 'patch' }).status).toBe('prepared');
      expect(model.prepare({ id: 'locked', patch: { name: 'locked', transform: { x: 0 } }, type: 'patch' })).toEqual({
        status: 'unchanged',
      });
    });

    it('takes a pre-gesture baseline so a previewed patch still records a real inverse', () => {
      const previewed = applyCanvasProjectMutation(projectWith(interleaved(), 'r1'), {
        id: 'r1',
        patch: { opacity: 0.4 },
        type: 'updateCanvasLayer',
      });
      const model = modelOf(previewed);
      expect(model.prepare({ id: 'r1', patch: { opacity: 0.4 }, type: 'patch' })).toEqual({ status: 'unchanged' });

      const result = model.prepare({ before: { opacity: 1 }, id: 'r1', patch: { opacity: 0.4 }, type: 'patch' });
      expect(result).toMatchObject({
        edit: { inverse: { id: 'r1', patch: { opacity: 1 }, type: 'updateCanvasLayer' } },
        status: 'prepared',
      });
      expect(model.prepare({ before: { opacity: 0.4 }, id: 'r1', patch: { opacity: 0.4 }, type: 'patch' })).toEqual({
        status: 'unchanged',
      });
      expect(
        model.prepare({ before: { name: 'r1', opacity: 1 }, id: 'r1', patch: { opacity: 0.4 }, type: 'patch' })
      ).toEqual({ operation: 'patch baseline names other fields', status: 'unsupported' });
      expect(
        modelOf(projectWith(interleaved(), 'r1')).prepare({
          before: { opacity: 1 },
          id: 'r1',
          patch: { opacity: 0.4 },
          type: 'patch',
        }).status
      ).toBe('prepared');

      const fillBefore = { color: '#e07575', style: 'diagonal' as const };
      const fillNext = { color: '#00ff00', style: 'diagonal' as const };
      const previewedFill = applyCanvasProjectMutation(projectWith(interleaved(), 'i1'), {
        config: { layerType: 'inpaint_mask', mask: { fill: fillNext } },
        id: 'i1',
        type: 'updateCanvasLayerConfig',
      });
      const fill = modelOf(previewedFill).prepare({
        before: { layerType: 'inpaint_mask', mask: { fill: fillBefore } },
        config: { layerType: 'inpaint_mask', mask: { fill: { ...fillNext } } },
        id: 'i1',
        type: 'patch-config',
      });
      expect(fill).toMatchObject({
        edit: { inverse: { config: { layerType: 'inpaint_mask', mask: { fill: fillBefore } }, id: 'i1' } },
        status: 'prepared',
      });
      expect(
        modelOf(previewedFill).prepare({
          before: { layerType: 'inpaint_mask', mask: { fill: { ...fillNext } } },
          config: { layerType: 'inpaint_mask', mask: { fill: { ...fillNext } } },
          id: 'i1',
          type: 'patch-config',
        })
      ).toEqual({ status: 'unchanged' });
      expect(
        modelOf(previewedFill).prepare({
          config: { layerType: 'inpaint_mask', mask: { fill: { ...fillNext } } },
          id: 'i1',
          type: 'patch-config',
        })
      ).toEqual({ status: 'unchanged' });
    });

    it('round-trips config, source and flag commands through the reducer', () => {
      const project = projectWith(interleaved(), 'r1');
      const control = roundTrip(project, {
        config: { adapter: { weight: 0.5 }, layerType: 'control', withTransparencyEffect: true },
        id: 'c1',
        type: 'patch-config',
      });
      expect(control.after.canvas.document.layers[2]).toMatchObject({
        adapter: { weight: 0.5 },
        withTransparencyEffect: true,
      });
      expect(control.edit.inverse).toEqual({
        config: { adapter: { weight: 1 }, layerType: 'control', withTransparencyEffect: false },
        id: 'c1',
        type: 'updateCanvasLayerConfig',
      });

      const source = { bitmap: null, offset: { x: 3, y: 4 }, type: 'paint' as const };
      const patched = roundTrip(project, { id: 'r2', source, type: 'patch-source' });
      expect((patched.after.canvas.document.layers[3] as { source: unknown }).source).toBe(source);

      const enabled = roundTrip(project, {
        type: 'set-enabled',
        updates: [
          { id: 'r1', isEnabled: false },
          { id: 'c1', isEnabled: true },
        ],
      });
      expect(enabled.edit).toMatchObject({ touchedIds: ['r1'], touchedStacks: ['raster'] });

      const hidden = roundTrip(project, { type: 'set-hidden', updates: [{ id: 'c1', isHidden: true }] });
      expect(hidden.after.canvas.document.layers[2]).toMatchObject({ isHidden: true });

      const locked = roundTrip(project, { type: 'set-locked', updates: [{ id: 'g1', isLocked: true }] });
      expect(locked.after.canvas.document.layers[4]).toMatchObject({ isLocked: true });
    });

    it.each<[string, FlatDocumentCommand, PrepareFlatEditResult]>([
      [
        'hiding a raster layer',
        { type: 'set-hidden', updates: [{ id: 'r1', isHidden: true }] },
        { actual: 'raster', expected: ['control', 'inpaint_mask', 'regional_guidance'], status: 'wrong-type' },
      ],
      [
        'a config patch for another layer type',
        { config: { layerType: 'control', withTransparencyEffect: true }, id: 'r1', type: 'patch-config' },
        { actual: 'raster', expected: ['control'], status: 'wrong-type' },
      ],
      [
        'a source patch on a mask',
        { id: 'i1', source: { bitmap: null, type: 'paint' }, type: 'patch-source' },
        { actual: 'inpaint_mask', expected: ['raster', 'control'], status: 'wrong-type' },
      ],
      [
        'an empty flag update',
        { type: 'set-locked', updates: [] },
        { operation: 'set-locked nothing', status: 'unsupported' },
      ],
      [
        'flags that already hold',
        { type: 'set-enabled', updates: [{ id: 'r1', isEnabled: true }] },
        { status: 'unchanged' },
      ],
    ])('answers %s', (_label, command, result) => {
      expect(modelOf(projectWith(interleaved(), 'r1')).prepare(command)).toEqual(result);
    });

    it('selects without recording history and reports the current selection as unchanged', () => {
      const project = projectWith(interleaved(), 'r1');
      const { edit } = roundTrip(project, { id: 'c1', type: 'select' });
      expect(edit).toMatchObject({ history: 'none', selectionAfter: 'c1', selectionBefore: 'r1', touchedIds: [] });
      expect(modelOf(project).prepare({ id: 'r1', type: 'select' })).toEqual({ status: 'unchanged' });
    });

    it.each<[string, FlatDocumentCommand, PrepareFlatEditResult]>([
      ['a move already at the boundary', { ids: ['r1'], kind: 'front', type: 'move' }, { status: 'unchanged' }],
      [
        'a reorder that keeps the order',
        { stacks: [{ orderedIds: ['r1', 'r2', 'r3'], stack: 'raster' }], type: 'reorder' },
        { status: 'unchanged' },
      ],
    ])('reports %s as unchanged', (_label, command, result) => {
      expect(modelOf(projectWith(interleaved(), 'r1')).prepare(command)).toEqual(result);
    });

    it.each<[string, FlatDocumentCommand, PrepareFlatEditResult]>([
      ['a missing removal', { ids: ['ghost', 'r1'], type: 'remove' }, { ids: ['ghost'], status: 'missing' }],
      ['a locked removal', { ids: ['locked'], type: 'remove' }, { ids: ['locked'], status: 'locked' }],
      ['an empty removal', { ids: [], type: 'remove' }, { operation: 'remove nothing', status: 'unsupported' }],
      [
        'a clashing insert',
        { aboveId: null, layers: [layer('r1')], type: 'insert' },
        { reason: 'id-exists', status: 'invalid-target', targetId: 'r1' },
      ],
      [
        'an empty insert',
        { aboveId: null, layers: [], type: 'insert' },
        { operation: 'insert nothing', status: 'unsupported' },
      ],
      [
        'a missing duplicate source',
        { newId: 'x', sourceId: 'ghost', type: 'duplicate' },
        { ids: ['ghost'], status: 'missing' },
      ],
      [
        'a duplicate onto an existing id',
        { newId: 'r1', sourceId: 'r2', type: 'duplicate' },
        { reason: 'id-exists', status: 'invalid-target', targetId: 'r1' },
      ],
      ['an empty move', { ids: [], kind: 'front', type: 'move' }, { operation: 'move nothing', status: 'unsupported' }],
      [
        'a reorder missing a member',
        { stacks: [{ orderedIds: ['r1'], stack: 'raster' }], type: 'reorder' },
        { reason: 'not-stack-members', status: 'invalid-target', targetId: 'r1' },
      ],
      [
        'a reorder naming a foreign id',
        { stacks: [{ orderedIds: ['r1', 'r2', 'c1'], stack: 'raster' }], type: 'reorder' },
        { reason: 'foreign-stack', status: 'invalid-target', targetId: 'c1' },
      ],
      [
        'a reorder naming an unknown id',
        { stacks: [{ orderedIds: ['r1', 'r2', 'ghost'], stack: 'raster' }], type: 'reorder' },
        { ids: ['ghost'], status: 'missing' },
      ],
      [
        'a reorder of one stack twice',
        {
          stacks: [
            { orderedIds: ['r2', 'r1', 'r3'], stack: 'raster' },
            { orderedIds: ['r1', 'r2', 'r3'], stack: 'raster' },
          ],
          type: 'reorder',
        },
        { operation: 'reorder one stack twice', status: 'unsupported' },
      ],
      [
        'a patch of nothing',
        { id: 'r1', patch: {}, type: 'patch' },
        { operation: 'patch nothing', status: 'unsupported' },
      ],
      ['a selection of a missing layer', { id: 'ghost', type: 'select' }, { ids: ['ghost'], status: 'missing' }],
    ])('refuses %s', (_label, command, refusal) => {
      const project = projectWith([...interleaved(), layer('locked', 'raster', { isLocked: true })], 'r1');
      expect(modelOf(project).prepare(command)).toEqual(refusal);
    });

    it('stamps every prepared edit with the project id and edit revision it was built against', () => {
      const project = projectWith(interleaved(), 'r1');
      const result = createFlatDocumentModel(project.canvas.document, {
        editRevision: 7,
        projectId: project.id,
      }).prepare({
        ids: ['r1'],
        type: 'remove',
      });
      expect(result).toMatchObject({ edit: { expectedRevision: 7, projectId: project.id }, status: 'prepared' });
    });
  });

  describe('canMergeDown', () => {
    it('targets the layer directly below in flat order, like the reducer', () => {
      const project = projectWith([layer('a'), layer('b'), layer('c1', 'control'), layer('r2')], 'a');
      const model = modelOf(project);
      expect(model.canMergeDown('a')).toEqual({ lowerId: 'b', status: 'eligible', upperId: 'a' });
      expect(model.canMergeDown('b')).toEqual({ reason: 'not-mergeable', status: 'invalid-target', targetId: 'c1' });
    });

    it('reports an unmergeable neighbour before a lock and a lock before a disabled layer', () => {
      const lockedControl = projectWith([layer('r1'), layer('c1', 'control', { isLocked: true })], null);
      expect(modelOf(lockedControl).canMergeDown('r1')).toEqual({
        reason: 'not-mergeable',
        status: 'invalid-target',
        targetId: 'c1',
      });
      const lockedUpper = projectWith([layer('a', 'raster', { isEnabled: false, isLocked: true }), layer('b')], null);
      expect(modelOf(lockedUpper).canMergeDown('a')).toEqual({ ids: ['a'], status: 'locked' });
    });

    it.each<[string, CanvasLayerContract[], string, object]>([
      ['the bottom layer', interleaved(), 'r3', { reason: 'no-layer-below', status: 'invalid-target', targetId: 'r3' }],
      ['a mask', interleaved(), 'i1', { actual: 'inpaint_mask', expected: ['raster'], status: 'wrong-type' }],
      ['a missing id', interleaved(), 'ghost', { ids: ['ghost'], status: 'missing' }],
      [
        'a locked lower layer',
        [layer('a'), layer('b', 'raster', { isLocked: true })],
        'a',
        { ids: ['b'], status: 'locked' },
      ],
      [
        'a disabled upper layer',
        [layer('a', 'raster', { isEnabled: false }), layer('b')],
        'a',
        { reason: 'not-mergeable', status: 'invalid-target', targetId: 'a' },
      ],
    ])('refuses %s', (_label, layers, upperId, refusal) => {
      expect(modelOf(projectWith(layers, null)).canMergeDown(upperId)).toEqual(refusal);
    });
  });
});

describe('checkFlatEditPostconditions', () => {
  const document = projectWith(interleaved(), 'r2').canvas.document;

  it.each([
    ['present ids', { ids: ['r1', 'c1'], kind: 'present' as const }, true],
    ['a missing present id', { ids: ['r1', 'ghost'], kind: 'present' as const }, false],
    ['absent ids', { ids: ['ghost'], kind: 'absent' as const }, true],
    ['a present absent id', { ids: ['r1'], kind: 'absent' as const }, false],
    [
      'the exact stack order',
      { kind: 'stack-order' as const, orderedIds: ['r1', 'r2', 'r3'], stack: 'raster' as const },
      true,
    ],
    [
      'a shorter stack order',
      { kind: 'stack-order' as const, orderedIds: ['r1', 'r2'], stack: 'raster' as const },
      false,
    ],
    [
      'a permuted stack order',
      { kind: 'stack-order' as const, orderedIds: ['r2', 'r1', 'r3'], stack: 'raster' as const },
      false,
    ],
    ['the selection', { id: 'r2', kind: 'selection' as const }, true],
    ['another selection', { id: 'r1', kind: 'selection' as const }, false],
    ['an applied patch', { id: 'r1', kind: 'patched' as const, patch: { name: 'r1', transform: { x: 0 } } }, true],
    ['an unapplied patch', { id: 'r1', kind: 'patched' as const, patch: { name: 'r1', transform: { x: 3 } } }, false],
    ['a patch of a missing layer', { id: 'ghost', kind: 'patched' as const, patch: { name: 'x' } }, false],
  ])('checks %s', (_label, postcondition, expected) => {
    expect(checkFlatEditPostconditions(document, [postcondition])).toBe(expected);
  });
});
