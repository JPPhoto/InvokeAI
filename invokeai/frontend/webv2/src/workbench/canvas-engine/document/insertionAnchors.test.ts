import type { CanvasLayerContract } from '@workbench/canvas-engine/contracts';

import { describe, expect, it } from 'vitest';

import {
  captureInsertionAnchor,
  captureRestoreAnchor,
  insertLayersAtAnchor,
  resolveInsertionIndex,
} from './insertionAnchors';

const layer = (id: string, type: CanvasLayerContract['type'] = 'raster'): CanvasLayerContract =>
  ({ id, type }) as CanvasLayerContract;

const layers = [layer('i1', 'inpaint_mask'), layer('r1'), layer('c1', 'control'), layer('r2'), layer('r3')];
const ids = (entries: readonly CanvasLayerContract[]): string[] => entries.map((entry) => entry.id);
const capture = { editRevision: 7, projectId: 'p' };

describe('captureInsertionAnchor', () => {
  it('anchors above a compatible leaf and remembers the same-stack member above it', () => {
    expect(captureInsertionAnchor(layers, { ...capture, aboveId: 'r2', stack: 'raster' })).toEqual({
      afterId: 'r1',
      beforeId: 'r2',
      capturedEditRevision: 7,
      projectId: 'p',
      stack: 'raster',
    });
    expect(captureInsertionAnchor(layers, { ...capture, aboveId: 'r1', stack: 'raster' })).toMatchObject({
      afterId: null,
      beforeId: 'r1',
    });
  });

  it('falls back to the stack top for an incompatible, absent, or omitted leaf', () => {
    const top = { afterId: null, beforeId: 'r1', capturedEditRevision: 7, projectId: 'p', stack: 'raster' };

    expect(captureInsertionAnchor(layers, { ...capture, aboveId: 'c1', stack: 'raster' })).toEqual(top);
    expect(captureInsertionAnchor(layers, { ...capture, aboveId: 'ghost', stack: 'raster' })).toEqual(top);
    expect(captureInsertionAnchor(layers, { ...capture, stack: 'raster' })).toEqual(top);
    expect(captureInsertionAnchor(layers, { ...capture, stack: 'regional_guidance' })).toMatchObject({
      afterId: null,
      beforeId: null,
    });
  });
});

describe('captureRestoreAnchor', () => {
  it('captures the same-stack neighbours on both sides', () => {
    expect(captureRestoreAnchor(layers, 'r2', 'p', 3)).toEqual({
      afterId: 'r1',
      beforeId: 'r3',
      capturedEditRevision: 3,
      projectId: 'p',
      stack: 'raster',
    });
    expect(captureRestoreAnchor(layers, 'c1', 'p', 3)).toMatchObject({
      afterId: null,
      beforeId: null,
      stack: 'control',
    });
    expect(captureRestoreAnchor(layers, 'ghost', 'p', 3)).toBeNull();
  });
});

describe('resolveInsertionIndex', () => {
  const anchor = captureInsertionAnchor(layers, { ...capture, aboveId: 'r2', stack: 'raster' });

  it('lands before a surviving beforeId', () => {
    expect(resolveInsertionIndex(layers, anchor)).toBe(3);
  });

  it('lands after a surviving afterId once beforeId is gone', () => {
    const withoutR2 = layers.filter((entry) => entry.id !== 'r2');
    expect(resolveInsertionIndex(withoutR2, anchor)).toBe(2);
  });

  it('lands at the stack top when neither survives, or at 0 for an empty stack', () => {
    const onlyR3 = [layer('i1', 'inpaint_mask'), layer('c1', 'control'), layer('r3')];
    expect(resolveInsertionIndex(onlyR3, anchor)).toBe(2);
    expect(resolveInsertionIndex([layer('i1', 'inpaint_mask')], anchor)).toBe(0);
  });

  it('ignores ids that moved to another stack', () => {
    const retyped = layers.map((entry) => (entry.id === 'r2' ? layer('r2', 'control') : entry));
    expect(resolveInsertionIndex(retyped, anchor)).toBe(2);
  });
});

describe('insertLayersAtAnchor', () => {
  it('splices the inserted layers at the resolved index', () => {
    const anchor = captureInsertionAnchor(layers, { ...capture, aboveId: 'r2', stack: 'raster' });
    expect(ids(insertLayersAtAnchor(layers, anchor, [layer('n1'), layer('n2')]))).toEqual([
      'i1',
      'r1',
      'c1',
      'n1',
      'n2',
      'r2',
      'r3',
    ]);
  });
});
