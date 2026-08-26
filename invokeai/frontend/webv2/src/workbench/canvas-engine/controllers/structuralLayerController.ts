import type { StructuralCommitOptions, StructuralCommitResult } from '@workbench/canvas-engine/capabilities';
import type { CanvasDocumentContractV2 } from '@workbench/canvas-engine/contracts';
import type { CanvasProjectMutation } from '@workbench/canvas-engine/mutationContracts';

import { createDocumentPatchEntry } from '@workbench/canvas-engine/history/documentPatch';

import type { CanvasMutationContext } from './mutationContext';

export type StructuralMutationContext = Pick<
  CanvasMutationContext,
  | 'canEdit'
  | 'capturePermit'
  | 'dispatch'
  | 'dispatchPrepared'
  | 'getDocument'
  | 'getEditRevision'
  | 'getReducerDocument'
  | 'history'
  | 'isGestureActive'
>;

export type StructuralFailureReport =
  | 'Structural edit could not be reverted'
  | 'Structural edit could not be mirrored'
  | 'Structural history replay was refused'
  | 'Structural history replay could not be mirrored';

export interface StructuralLayerControllerOptions {
  readonly ctx: StructuralMutationContext;
  readonly getSelectedLayerIds?: (document: CanvasDocumentContractV2) => readonly string[];
  readonly report?: (message: StructuralFailureReport, label: string, error: unknown) => void;
  readonly now?: () => number;
}

interface NudgeBurst {
  expiresAt: number;
  selectionKey: string;
  origins: readonly { id: string; x: number; y: number }[];
}

const NUDGE_COALESCE_MS = 500;

const positionMutation = (positions: readonly { id: string; x: number; y: number }[]): CanvasProjectMutation =>
  positions.length === 1
    ? {
        id: positions[0]!.id,
        patch: { transform: { x: positions[0]!.x, y: positions[0]!.y } },
        type: 'updateCanvasLayer',
      }
    : { type: 'setCanvasLayerPositions', updates: [...positions] };

/** Owns guarded, failure-atomic structural document edits and nudge coalescing. */
export class StructuralLayerController {
  private burst: NudgeBurst | null = null;
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly deps: StructuralLayerControllerOptions) {
    this.now = deps.now ?? Date.now;
  }

  endBurst(): void {
    this.burst = null;
  }

  canCommit(): boolean {
    const { ctx } = this.deps;
    return !this.disposed && ctx.canEdit() && !ctx.isGestureActive();
  }

  commit(
    label: string,
    forward: CanvasProjectMutation,
    inverse: CanvasProjectMutation,
    options: StructuralCommitOptions = {}
  ): StructuralCommitResult {
    const refusal = this.refuse(options);
    if (refusal) {
      return refusal;
    }
    this.endBurst();
    const applied = this.apply(label, forward, inverse, options.verify);
    if (applied.status === 'committed') {
      this.deps.ctx.history.push(this.entry(label, forward, inverse));
    }
    return applied;
  }

  preview(action: CanvasProjectMutation): boolean {
    if (!this.canCommit()) {
      return false;
    }
    this.deps.ctx.dispatch(action);
    return true;
  }

  nudge(dx: number, dy: number): StructuralCommitResult {
    const { ctx } = this.deps;
    const refusal = this.refuse({});
    if (refusal) {
      return refusal;
    }
    const document = ctx.getDocument();
    if (!document?.selectedLayerId) {
      return { status: 'dispatch-rejected' };
    }
    const requested = new Set(this.deps.getSelectedLayerIds?.(document) ?? [document.selectedLayerId]);
    const layers = document.layers.filter((layer) => requested.has(layer.id));
    if (
      layers.length === 0 ||
      layers.length !== requested.size ||
      !requested.has(document.selectedLayerId) ||
      layers.some((layer) => layer.isLocked || !layer.isEnabled)
    ) {
      return { status: 'dispatch-rejected' };
    }
    const selectionKey = layers.map((layer) => layer.id).join('\0');
    const now = this.now();
    const coalesce = !!this.burst && this.burst.selectionKey === selectionKey && now < this.burst.expiresAt;
    const origins =
      coalesce && this.burst
        ? this.burst.origins
        : layers.map((layer) => ({ id: layer.id, x: layer.transform.x, y: layer.transform.y }));
    const next = layers.map((layer) => ({ id: layer.id, x: layer.transform.x + dx, y: layer.transform.y + dy }));
    const label = 'Nudge layer';
    const forward = positionMutation(next);
    const inverse = positionMutation(origins);
    const applied = this.apply(label, forward, inverse);
    if (applied.status !== 'committed') {
      this.burst = null;
      return applied;
    }
    const entry = this.entry(label, forward, inverse);
    if (coalesce) {
      ctx.history.amendLast(entry);
    } else {
      ctx.history.push(entry);
    }
    this.burst = { expiresAt: now + NUDGE_COALESCE_MS, origins, selectionKey };
    return applied;
  }

  dispose(): void {
    this.disposed = true;
    this.endBurst();
  }

  private refuse(options: StructuralCommitOptions): StructuralCommitResult | null {
    const { ctx } = this.deps;
    if (this.disposed) {
      return { status: 'not-ready' };
    }
    if (!ctx.capturePermit()) {
      return { status: 'busy' };
    }
    if (ctx.isGestureActive()) {
      return { status: 'gesture-active' };
    }
    if (!ctx.getReducerDocument()) {
      return { status: 'not-ready' };
    }
    const actualRevision = ctx.getEditRevision();
    if (options.expectedRevision !== undefined && options.expectedRevision !== actualRevision) {
      return { actualRevision, expectedRevision: options.expectedRevision, status: 'stale' };
    }
    return null;
  }

  /** Dispatches `forward` once through the guarded context; a verified failure applies `inverse`. */
  private apply(
    label: string,
    forward: CanvasProjectMutation,
    inverse: CanvasProjectMutation,
    verify: (document: CanvasDocumentContractV2) => boolean = () => true
  ): StructuralCommitResult {
    const { ctx } = this.deps;
    const before = ctx.getReducerDocument();
    const isMirrored = (): boolean => ctx.getDocument() === ctx.getReducerDocument();
    const isApplied = (): boolean => {
      const document = ctx.getReducerDocument();
      return document !== null && document !== before && verify(document);
    };
    try {
      ctx.dispatchPrepared(forward, isApplied, isMirrored);
      return { status: 'committed' };
    } catch (error) {
      const after = ctx.getReducerDocument();
      if (after === before) {
        return { status: 'dispatch-rejected' };
      }
      let recoveryError: unknown = error;
      try {
        ctx.dispatchPrepared(inverse, () => ctx.getReducerDocument() !== after, isMirrored, 'system');
      } catch (inverseError) {
        recoveryError = inverseError;
      }
      const recovered =
        ctx.getReducerDocument() === after ? 'unreverted' : isMirrored() ? 'reverted' : 'reverted-unmirrored';
      if (recovered === 'unreverted') {
        this.deps.report?.('Structural edit could not be reverted', label, recoveryError);
      } else if (recovered === 'reverted-unmirrored') {
        this.deps.report?.('Structural edit could not be mirrored', label, recoveryError);
      }
      return { recovered, status: 'postcondition-failed' };
    }
  }

  private entry(label: string, forward: CanvasProjectMutation, inverse: CanvasProjectMutation) {
    return createDocumentPatchEntry({
      dispatch: (action) => this.replay(label, action, forward, inverse),
      forward,
      inverse,
      label,
      replayFailureAtomic: true,
    });
  }

  /**
   * A reducer that refuses a replay (its target changed since) is expected: the entry moves as a
   * no-op and the refusal is reported. A mirror that cannot follow an accepted replay is not: the
   * opposite action restores the reducer and the failure surfaces.
   */
  private replay(
    label: string,
    action: CanvasProjectMutation,
    forward: CanvasProjectMutation,
    inverse: CanvasProjectMutation
  ): void {
    const { ctx } = this.deps;
    const before = ctx.getReducerDocument();
    try {
      ctx.dispatchPrepared(
        action,
        () => ctx.getReducerDocument() !== before,
        () => ctx.getDocument() === ctx.getReducerDocument()
      );
    } catch (error) {
      if (ctx.getReducerDocument() === before) {
        this.deps.report?.('Structural history replay was refused', label, error);
        return;
      }
      this.deps.report?.('Structural history replay could not be mirrored', label, error);
      ctx.dispatch(action === forward ? inverse : forward, 'system');
      throw error;
    }
  }
}
