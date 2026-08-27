import type { CanvasLayerContract } from '@workbench/canvas-engine/contracts';
import type {
  LayerStackKind,
  LayerStackMoveKind,
  ReorderFlatStackCommand,
} from '@workbench/canvas-engine/document/layerStacks';
import type { CanvasLayerBasePatch, CanvasProjectMutation } from '@workbench/canvas-engine/mutationContracts';

import type { FlatEditPostcondition } from './postconditions';

export type FlatDocumentCommand =
  | {
      readonly type: 'insert';
      readonly layers: readonly CanvasLayerContract[];
      /** Land above this layer when it belongs to the inserted layer's stack; otherwise at the stack top. */
      readonly aboveId: string | null;
      /** The primary selection afterwards; defaults to the last inserted layer. */
      readonly selectId?: string | null;
    }
  | { readonly type: 'remove'; readonly ids: readonly string[] }
  | { readonly type: 'duplicate'; readonly sourceId: string; readonly newId: string }
  | { readonly type: 'move'; readonly ids: readonly string[]; readonly kind: LayerStackMoveKind }
  | { readonly type: 'reorder'; readonly stacks: readonly ReorderFlatStackCommand[] }
  | { readonly type: 'patch'; readonly id: string; readonly patch: CanvasLayerBasePatch }
  | { readonly type: 'select'; readonly id: string | null };

export type FlatDocumentRefusal =
  | { readonly status: 'missing'; readonly ids: readonly string[] }
  | { readonly status: 'locked'; readonly ids: readonly string[] }
  | {
      readonly status: 'wrong-type';
      readonly expected: readonly CanvasLayerContract['type'][];
      readonly actual: string;
    }
  | { readonly status: 'invalid-target'; readonly targetId: string; readonly reason: FlatInvalidTargetReason }
  | { readonly status: 'unsupported'; readonly operation: string };

export type FlatInvalidTargetReason =
  | 'id-exists'
  | 'foreign-stack'
  | 'not-stack-members'
  | 'no-layer-below'
  | 'not-mergeable';

export type FlatEditHistoryPolicy = 'record' | 'none';

/** A flat edit ready for the transaction module: what to dispatch, what must hold afterwards, how to record it. */
export interface PreparedFlatEdit {
  readonly forward: CanvasProjectMutation;
  readonly inverse: CanvasProjectMutation;
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly selectionBefore: string | null;
  readonly selectionAfter: string | null;
  readonly touchedIds: readonly string[];
  readonly touchedStacks: readonly LayerStackKind[];
  readonly postconditions: readonly FlatEditPostcondition[];
  /** Flat commands never need prepared pixels; pixel-bearing edits keep their own controllers. */
  readonly rasterWork: null;
  readonly history: FlatEditHistoryPolicy;
}

export type PrepareFlatEditResult =
  | { readonly status: 'prepared'; readonly edit: PreparedFlatEdit }
  /** The command describes the document as it already is; there is nothing to dispatch. */
  | { readonly status: 'unchanged' }
  | FlatDocumentRefusal;

export type MergeDownEligibility =
  | { readonly status: 'eligible'; readonly upperId: string; readonly lowerId: string }
  | FlatDocumentRefusal;
