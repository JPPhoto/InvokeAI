import type { CanvasStructuralEngine, StructuralCommitResult } from '@workbench/canvas-engine/api';
import type { CanvasProjectMutation } from '@workbench/canvasProjectMutations';
import type { TFunction } from 'i18next';

import { useNotify } from '@workbench/useNotify';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export type StructuralCommit = (
  label: string,
  forward: CanvasProjectMutation,
  inverse: CanvasProjectMutation
) => StructuralCommitResult;

/** Commits through the engine's guarded history; without a mounted engine there is no transaction context. */
export const commitStructuralEdit = (
  engine: CanvasStructuralEngine | null,
  label: string,
  forward: CanvasProjectMutation,
  inverse: CanvasProjectMutation
): StructuralCommitResult =>
  engine ? engine.layers.commitStructural(label, forward, inverse) : { status: 'not-ready' };

/**
 * Explains a refused structural edit. `busy` stays silent because an in-flight operation already
 * disables the controls that could reach here; every other refusal drops the edit and says so.
 */
export const reportStructuralCommit = (
  result: StructuralCommitResult,
  reportError: (title: string, message: string) => void,
  t: TFunction
): void => {
  const title = t('widgets.canvas.structural.failed');
  switch (result.status) {
    case 'committed':
    case 'busy':
      return;
    case 'gesture-active':
      reportError(title, t('widgets.canvas.structural.gestureActive'));
      return;
    case 'not-ready':
      reportError(title, t('widgets.canvas.structural.notReady'));
      return;
    case 'stale':
      reportError(title, t('widgets.canvas.structural.stale'));
      return;
    case 'dispatch-rejected':
      reportError(title, t('widgets.canvas.structural.rejected'));
      return;
    case 'postcondition-failed':
      switch (result.recovered) {
        case 'reverted':
          reportError(title, t('widgets.canvas.structural.reverted'));
          return;
        case 'reverted-unmirrored':
          reportError(title, t('widgets.canvas.structural.unmirrored'));
          return;
        case 'unreverted':
          reportError(title, t('widgets.canvas.structural.unverified'));
      }
  }
};

/** A widget-side structural commit that reports the refusals the user needs to hear about. */
export const useStructuralCommit = (engine: CanvasStructuralEngine | null): StructuralCommit => {
  const notify = useNotify();
  const { t } = useTranslation();

  return useCallback(
    (label, forward, inverse) => {
      const result = commitStructuralEdit(engine, label, forward, inverse);

      reportStructuralCommit(result, notify.error, t);
      return result;
    },
    [engine, notify, t]
  );
};
