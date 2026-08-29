import type { GeneratedImageContract } from '@features/gallery';

export type RegionalGuidanceReferenceImageAsset = GeneratedImageContract;

export type RegionalGuidanceIPAdapterMethod = 'full' | 'style' | 'composition' | 'style_strong' | 'style_precise';

export interface RegionalGuidanceModelRef {
  key: string;
  name: string;
  base: string;
  type: string;
  format?: string;
  variant?: string | null;
  hash?: string;
  submodel_type?: string;
  [key: string]: unknown;
}

export type RegionalGuidanceReferenceImageConfig =
  | {
      type: 'ip_adapter';
      image: RegionalGuidanceReferenceImageAsset | null;
      model: RegionalGuidanceModelRef | null;
      weight: number;
      beginEndStepPct: [number, number];
      method: RegionalGuidanceIPAdapterMethod;
      clipVisionModel: 'ViT-H' | 'ViT-G' | 'ViT-L';
    }
  | {
      type: 'flux_redux';
      image: RegionalGuidanceReferenceImageAsset | null;
      model: RegionalGuidanceModelRef | null;
      imageInfluence: 'lowest' | 'low' | 'medium' | 'high' | 'highest';
    };

export interface RegionalGuidanceReferenceImage {
  id: string;
  isEnabled: boolean;
  config: RegionalGuidanceReferenceImageConfig;
}

export interface CanvasPlacementContract {
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
}

export interface CanvasStagingCandidateContract extends GeneratedImageContract {
  placement: CanvasPlacementContract;
  sourceBackendItemId?: number;
}

/** The legacy-shaped staging area; v3 state extends it with `autoSwitchMode`. */
export interface CanvasStagingAreaContract {
  sourceQueueItemId?: string;
  selectedLayerId?: string;
  pendingImageIds: string[];
  pendingImages: CanvasStagingCandidateContract[];
  selectedImageIndex: number;
  isVisible: boolean;
  areThumbnailsVisible: boolean;
}

// ---------------------------------------------------------------------------
// Canvas v3 document contracts
//
// A document holds four stack forests (raster, control, regional guidance and
// inpaint mask). Each forest is a top-first tree of leaves and pass-through
// groups. Leaves are positioned by `transform` and reference bitmaps by
// `imageName` (via `CanvasImageRef`) rather than by resolved URLs, since URLs
// are ephemeral. Groups organise leaves and gate their effective enabled,
// locked and hidden state; they carry no opacity, blend mode or transform.
// ---------------------------------------------------------------------------

export type CanvasBlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

/** A reference to a persisted image asset by name, not by resolved URL. */
export interface CanvasImageRef {
  imageName: string;
  width: number;
  height: number;
  contentHash?: string;
}

export type CanvasLayerSourceContract =
  | {
      type: 'paint';
      bitmap: CanvasImageRef | null;
      /**
       * The layer-local origin of `bitmap`'s top-left pixel. Paint layers are
       * content-sized: the persisted bitmap covers only the painted region, and
       * this offset records where that region sits in the layer's local space
       * (it can be negative). Absent (or `{ x: 0, y: 0 }`) for legacy documents
       * whose paint bitmaps were document-sized at the origin — they load
       * identically.
       */
      offset?: { x: number; y: number };
    }
  | { type: 'image'; image: CanvasImageRef }
  | {
      type: 'text';
      content: string;
      fontFamily: string;
      fontSize: number;
      fontWeight: number;
      lineHeight: number;
      align: 'left' | 'center' | 'right';
      color: string;
    }
  | {
      type: 'shape';
      kind: 'rect' | 'ellipse' | 'polygon';
      points?: { x: number; y: number }[];
      width: number;
      height: number;
      fill: string | null;
      stroke: string | null;
      strokeWidth: number;
    }
  | {
      type: 'gradient';
      kind: 'linear' | 'radial';
      angle: number;
      stops: { offset: number; color: string }[];
      /**
       * The gradient's explicit content extent (layer-local pixels). Gradient
       * layers are content-sized like every other layer: the extent is set at
       * creation (bbox-sized) and preserved across angle edits. Absent for legacy
       * documents whose gradients were document-sized by construction — they
       * default to the document dimensions on load (see `getSourceContentRect`).
       */
      width?: number;
      height?: number;
    };

export interface CanvasLayerBaseContract {
  id: string;
  name: string;
  isEnabled: boolean;
  isLocked: boolean;
  opacity: number;
  blendMode: CanvasBlendMode;
  transform: { x: number; y: number; scaleX: number; scaleY: number; rotation: number };
}

export interface CanvasAdjustmentsContract {
  brightness: number;
  contrast: number;
  saturation: number;
  curves?: { r: [number, number][]; g: [number, number][]; b: [number, number][] };
}

export interface CanvasControlAdapterContract {
  kind: 'controlnet' | 't2i_adapter' | 'control_lora' | 'z_image_control';
  model: string | null;
  weight: number;
  beginEndStepPct: [number, number];
  controlMode: 'balanced' | 'more_prompt' | 'more_control' | 'unbalanced' | null;
}

export interface CanvasMaskFillContract {
  style: 'solid' | 'grid' | 'crosshatch' | 'diagonal' | 'horizontal' | 'vertical';
  color: string;
}

export interface CanvasMaskContract {
  bitmap: CanvasImageRef | null;
  fill: CanvasMaskFillContract;
  /**
   * The layer-local origin of `bitmap`'s top-left pixel. Mask layers are
   * content-sized exactly like paint layers: the persisted mask bitmap covers
   * only the painted region, and this offset records where that region sits in
   * the layer's local space (it can be negative). Absent (or `{ x: 0, y: 0 }`)
   * for legacy documents whose mask bitmaps were document-sized at the origin —
   * they load identically. Mirrors {@link CanvasLayerSourceContract} `paint`.
   */
  offset?: { x: number; y: number };
}

export interface CanvasRasterLayerContractV2 extends CanvasLayerBaseContract {
  type: 'raster';
  source: CanvasLayerSourceContract;
  adjustments?: CanvasAdjustmentsContract;
  isTransparencyLocked?: boolean;
  filter?: { type: string; settings: Record<string, unknown> };
}

export interface CanvasControlLayerContract extends CanvasLayerBaseContract {
  type: 'control';
  source: CanvasLayerSourceContract;
  adapter: CanvasControlAdapterContract;
  withTransparencyEffect: boolean;
  filter?: { type: string; settings: Record<string, unknown> };
  /**
   * Whether this layer's on-canvas preview is suppressed. DISPLAY ONLY — a
   * hidden layer still affects generation exactly as it would if visible, which
   * is the whole point: you can get a control map or mask overlay out of the way
   * without changing the image it produces. Absent ⇒ not hidden.
   *
   * Only these three types carry it. For a raster layer, visibility and
   * participation are the SAME fact — the raster stack IS the generation
   * input — so `isEnabled` alone says everything, and a hidden-but-contributing
   * raster layer is deliberately not representable.
   */
  isHidden?: boolean;
}

export interface CanvasRegionalGuidanceLayerContract extends CanvasLayerBaseContract {
  type: 'regional_guidance';
  mask: CanvasMaskContract;
  positivePrompt: string | null;
  negativePrompt: string | null;
  autoNegative: boolean;
  referenceImages: RegionalGuidanceReferenceImage[];
  /**
   * Whether this layer's on-canvas preview is suppressed. DISPLAY ONLY — a
   * hidden layer still affects generation exactly as it would if visible, which
   * is the whole point: you can get a control map or mask overlay out of the way
   * without changing the image it produces. Absent ⇒ not hidden.
   *
   * Only these three types carry it. For a raster layer, visibility and
   * participation are the SAME fact — the raster stack IS the generation
   * input — so `isEnabled` alone says everything, and a hidden-but-contributing
   * raster layer is deliberately not representable.
   */
  isHidden?: boolean;
}

export interface CanvasInpaintMaskLayerContract extends CanvasLayerBaseContract {
  type: 'inpaint_mask';
  mask: CanvasMaskContract;
  noiseLevel?: number;
  denoiseLimit?: number;
  /**
   * Whether this layer's on-canvas preview is suppressed. DISPLAY ONLY — a
   * hidden layer still affects generation exactly as it would if visible, which
   * is the whole point: you can get a control map or mask overlay out of the way
   * without changing the image it produces. Absent ⇒ not hidden.
   *
   * Only these three types carry it. For a raster layer, visibility and
   * participation are the SAME fact — the raster stack IS the generation
   * input — so `isEnabled` alone says everything, and a hidden-but-contributing
   * raster layer is deliberately not representable.
   */
  isHidden?: boolean;
}

export type CanvasLayerContract =
  | CanvasRasterLayerContractV2
  | CanvasControlLayerContract
  | CanvasRegionalGuidanceLayerContract
  | CanvasInpaintMaskLayerContract;

export type CanvasLayerStackKind = CanvasLayerContract['type'];

/**
 * A pass-through group. It belongs to exactly one stack forest and may contain only that
 * stack's leaves and groups. `isHidden` is display-only and valid only in overlay stacks, with the
 * meaning the overlay leaves already give it; a raster group has no display-only hidden state.
 */
export interface CanvasGroupContract {
  id: string;
  type: 'group';
  name: string;
  isEnabled: boolean;
  isLocked: boolean;
  isHidden?: boolean;
  /** Index 0 is the top-most child. */
  children: CanvasNodeContract[];
}

export type CanvasNodeContract = CanvasLayerContract | CanvasGroupContract;

/** One top-first forest per stack; a node's stack is the forest it lives in. */
export type CanvasStackForests = Record<CanvasLayerStackKind, CanvasNodeContract[]>;

/** The composition order, bottom stack first; the one table every consumer reads. */
export const LAYER_STACK_ORDER: readonly CanvasLayerStackKind[] = [
  'raster',
  'control',
  'regional_guidance',
  'inpaint_mask',
];

/** The same stacks as the panel lists them, top first. */
export const LAYER_STACKS_TOP_FIRST: readonly CanvasLayerStackKind[] = [...LAYER_STACK_ORDER].reverse();

export const CANVAS_MAX_NODE_DEPTH = 10;
export const CANVAS_MAX_NODE_COUNT = 10_000;

export interface CanvasDocumentContractV3 {
  version: 3;
  width: number;
  height: number;
  background: 'transparent' | { color: string };
  stacks: CanvasStackForests;
  bbox: { x: number; y: number; width: number; height: number };
  /** A leaf or a group; leaf-only tools refuse a group rather than guessing a descendant. */
  selectedLayerId: string | null;
}

export interface CanvasSnapshotContract {
  id: string;
  name: string;
  createdAt: string;
  document: CanvasDocumentContractV3;
}

export interface CanvasStagingAreaContractV2 extends CanvasStagingAreaContract {
  autoSwitchMode: 'off' | 'latest' | 'progress';
}

export interface CanvasStateContractV3 {
  version: 3;
  document: CanvasDocumentContractV3;
  /**
   * Monotonic counter bumped whenever the document is swapped wholesale
   * (snapshot restore, `replaceCanvasDocument`) rather than incrementally
   * edited. The document mirror treats any change to this value as a full
   * document replacement (clearing engine pixel history), even when the new
   * document keeps the same dimensions and reuses layer ids — the case a
   * reference/dimension diff alone cannot distinguish from an ordinary edit.
   */
  documentRevision: number;
  snapshots: CanvasSnapshotContract[];
  stagingArea: CanvasStagingAreaContractV2;
}
