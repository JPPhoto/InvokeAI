import type { StructuralCommitResult } from '@workbench/canvas-engine/api';
import type { CanvasProjectMutation } from '@workbench/canvasProjectMutations';
import type { CanvasStructuralEngine } from '@workbench/widgets/layers/layerOps';
import type { TFunction } from 'i18next';

import { describe, expect, it, vi } from 'vitest';

import { commitStructuralEdit, reportStructuralCommit } from './useStructuralCommit';

const forward: CanvasProjectMutation = { ids: ['a'], type: 'removeCanvasLayers' };
const inverse: CanvasProjectMutation = { id: 'a', type: 'setCanvasSelectedLayer' };
const t = ((key: string) => key) as unknown as TFunction;

describe('commitStructuralEdit', () => {
  it('routes through the engine and returns its result', () => {
    const commitStructural = vi.fn(() => ({ status: 'committed' as const }));
    const engine = { layers: { commitStructural } } as unknown as CanvasStructuralEngine;

    expect(commitStructuralEdit(engine, 'Delete layer', forward, inverse)).toEqual({ status: 'committed' });
    expect(commitStructural).toHaveBeenCalledWith('Delete layer', forward, inverse);
  });

  it('refuses as not-ready without an engine instead of dispatching unrecorded', () => {
    expect(commitStructuralEdit(null, 'Delete layer', forward, inverse)).toEqual({ status: 'not-ready' });
  });
});

describe('reportStructuralCommit', () => {
  it.each<StructuralCommitResult>([{ status: 'committed' }, { status: 'busy' }])('stays silent for %j', (result) => {
    const report = vi.fn();

    reportStructuralCommit(result, report, t);

    expect(report).not.toHaveBeenCalled();
  });

  it.each<[StructuralCommitResult, string]>([
    [{ status: 'gesture-active' }, 'widgets.canvas.structural.gestureActive'],
    [{ status: 'not-ready' }, 'widgets.canvas.structural.notReady'],
    [{ actualRevision: 2, expectedRevision: 1, status: 'stale' }, 'widgets.canvas.structural.stale'],
    [{ status: 'dispatch-rejected' }, 'widgets.canvas.structural.rejected'],
    [{ recovered: 'reverted', status: 'postcondition-failed' }, 'widgets.canvas.structural.reverted'],
    [{ recovered: 'reverted-unmirrored', status: 'postcondition-failed' }, 'widgets.canvas.structural.unmirrored'],
    [{ recovered: 'unreverted', status: 'postcondition-failed' }, 'widgets.canvas.structural.unverified'],
  ])('explains %j', (result, message) => {
    const report = vi.fn();

    reportStructuralCommit(result, report, t);

    expect(report).toHaveBeenCalledWith('widgets.canvas.structural.failed', message);
  });
});
