import type {
  CanvasDocumentContractV2,
  CanvasImageRef,
  CanvasInpaintMaskLayerContract,
  CanvasLayerBaseContract,
  CanvasLayerContract,
  CanvasRasterLayerContractV2,
  CanvasSnapshotContract,
  CanvasStagingAreaContractV2,
  CanvasStateContractV2,
} from '@workbench/canvas-engine/api';

import { z } from 'zod';

import type { CanvasLoadDiagnostic, CanvasLoadResult, CanvasVersionScope } from './canvasLoadContracts';

import { normalizeControlAdapter } from './controlAdapters';

export const DEFAULT_CANVAS_DOCUMENT_WIDTH = 1024;
export const DEFAULT_CANVAS_DOCUMENT_HEIGHT = 1024;

const createMigrationId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const zFiniteNumber = z.number().finite();
const zCoordinate = z.object({ x: zFiniteNumber, y: zFiniteNumber });
const zImageRef = z.object({
  contentHash: z.string().optional(),
  height: zFiniteNumber.nonnegative(),
  imageName: z.string(),
  width: zFiniteNumber.nonnegative(),
});
const zPaintSource = z.object({
  bitmap: zImageRef.nullable(),
  offset: zCoordinate.optional(),
  type: z.literal('paint'),
});
const zLayerSource = z.discriminatedUnion('type', [
  zPaintSource,
  z.object({ image: zImageRef, type: z.literal('image') }),
  z.object({
    align: z.enum(['left', 'center', 'right']),
    color: z.string(),
    content: z.string(),
    fontFamily: z.string(),
    fontSize: zFiniteNumber,
    fontWeight: zFiniteNumber,
    lineHeight: zFiniteNumber,
    type: z.literal('text'),
  }),
  z.object({
    fill: z.string().nullable(),
    height: zFiniteNumber,
    kind: z.enum(['rect', 'ellipse', 'polygon']),
    points: z.array(zCoordinate).optional(),
    stroke: z.string().nullable(),
    strokeWidth: zFiniteNumber,
    type: z.literal('shape'),
    width: zFiniteNumber,
  }),
  z.object({
    angle: zFiniteNumber,
    height: zFiniteNumber.positive().optional(),
    kind: z.enum(['linear', 'radial']),
    stops: z.array(z.object({ color: z.string(), offset: zFiniteNumber })),
    type: z.literal('gradient'),
    width: zFiniteNumber.positive().optional(),
  }),
]);
const zTransform = z.object({
  rotation: zFiniteNumber,
  scaleX: zFiniteNumber,
  scaleY: zFiniteNumber,
  x: zFiniteNumber,
  y: zFiniteNumber,
});
const zFilter = z.object({ settings: z.record(z.string(), z.unknown()), type: z.string() });
const zCurve = z.array(z.tuple([zFiniteNumber, zFiniteNumber]));
const zAdjustments = z.object({
  brightness: zFiniteNumber,
  contrast: zFiniteNumber,
  curves: z.object({ b: zCurve, g: zCurve, r: zCurve }).optional(),
  saturation: zFiniteNumber,
});
const zControlAdapter = z
  .object({
    beginEndStepPct: z.tuple([zFiniteNumber, zFiniteNumber]),
    controlMode: z.enum(['balanced', 'more_prompt', 'more_control', 'unbalanced']).nullable(),
    kind: z.enum(['controlnet', 't2i_adapter', 'control_lora', 'z_image_control']),
    model: z.string().nullable(),
    weight: zFiniteNumber,
  })
  .refine(({ beginEndStepPct }) => {
    const [begin, end] = beginEndStepPct;
    return begin >= 0 && end <= 1 && begin < end;
  })
  .refine(({ kind, weight }) => weight >= (kind === 'z_image_control' ? 0 : -1) && weight <= 2);
const zMask = z.object({
  bitmap: zImageRef.nullable(),
  fill: z.object({
    color: z.string(),
    style: z.enum(['solid', 'grid', 'crosshatch', 'diagonal', 'horizontal', 'vertical']),
  }),
  offset: zCoordinate.optional(),
});
const zGeneratedImage = z.object({
  height: zFiniteNumber.nonnegative(),
  imageName: z.string(),
  imageUrl: z.string(),
  queuedAt: z.string(),
  sourceQueueItemId: z.string(),
  thumbnailUrl: z.string(),
  width: zFiniteNumber.nonnegative(),
});
const zModelIdentifier = z.object({ base: z.string(), key: z.string(), name: z.string(), type: z.string() });
const zReferenceImage = z.object({
  config: z.discriminatedUnion('type', [
    z.object({
      beginEndStepPct: z.tuple([zFiniteNumber, zFiniteNumber]),
      clipVisionModel: z.enum(['ViT-H', 'ViT-G', 'ViT-L']),
      image: zGeneratedImage.nullable(),
      method: z.enum(['full', 'style', 'composition', 'style_strong', 'style_precise']),
      model: zModelIdentifier.nullable(),
      type: z.literal('ip_adapter'),
      weight: zFiniteNumber,
    }),
    z.object({
      image: zGeneratedImage.nullable(),
      imageInfluence: z.enum(['lowest', 'low', 'medium', 'high', 'highest']),
      model: zModelIdentifier.nullable(),
      type: z.literal('flux_redux'),
    }),
    z.object({
      image: zGeneratedImage.nullable(),
      model: zModelIdentifier.nullable(),
      type: z.literal('flux_kontext_reference_image'),
    }),
    z.object({ image: zGeneratedImage.nullable(), type: z.literal('flux2_reference_image') }),
    z.object({ image: zGeneratedImage.nullable(), type: z.literal('qwen_image_reference_image') }),
    z.object({ image: zGeneratedImage.nullable(), type: z.literal('external_reference_image') }),
  ]),
  id: z.string(),
  isEnabled: z.boolean(),
});
const zLayerBase = z.object({
  blendMode: z.enum([
    'normal',
    'multiply',
    'screen',
    'overlay',
    'darken',
    'lighten',
    'color-dodge',
    'color-burn',
    'hard-light',
    'soft-light',
    'difference',
    'exclusion',
    'hue',
    'saturation',
    'color',
    'luminosity',
  ]),
  id: z.string(),
  isEnabled: z.boolean(),
  isLocked: z.boolean(),
  name: z.string(),
  opacity: zFiniteNumber.min(0).max(1),
  transform: zTransform,
});
const zCanvasLayer = z.discriminatedUnion('type', [
  zLayerBase.extend({
    adjustments: zAdjustments.optional(),
    filter: zFilter.optional(),
    isTransparencyLocked: z.boolean().optional(),
    source: zLayerSource,
    type: z.literal('raster'),
  }),
  zLayerBase.extend({
    adapter: zControlAdapter,
    filter: zFilter.optional(),
    // Display-only visibility; absent ⇒ not hidden, so older documents load
    // unchanged. Only the three overlay types carry it — see `contracts.ts`.
    isHidden: z.boolean().optional(),
    source: zLayerSource,
    type: z.literal('control'),
    withTransparencyEffect: z.boolean(),
  }),
  zLayerBase.extend({
    autoNegative: z.boolean(),
    isHidden: z.boolean().optional(),
    mask: zMask,
    negativePrompt: z.string().nullable(),
    positivePrompt: z.string().nullable(),
    referenceImages: z.array(zReferenceImage),
    type: z.literal('regional_guidance'),
  }),
  zLayerBase.extend({
    denoiseLimit: zFiniteNumber.optional(),
    isHidden: z.boolean().optional(),
    mask: zMask,
    noiseLevel: zFiniteNumber.optional(),
    type: z.literal('inpaint_mask'),
  }),
]);

const asNumber = (value: unknown, fallback: number): number => (typeof value === 'number' ? value : fallback);

const asString = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);

const asPositiveNumber = (value: unknown, fallback: number): number => {
  const numeric = asNumber(value, fallback);

  return numeric > 0 ? numeric : fallback;
};

/** A positive whole-pixel dimension, shared by creation and every migration path. */
const asPositiveInteger = (value: unknown, fallback: number): number =>
  Math.max(1, Math.round(asPositiveNumber(value, fallback)));

/** The canonical whole-pixel geometry for a live or persisted canvas document. */
const normalizeCanvasDocumentGeometry = (rawWidth: unknown, rawHeight: unknown, rawBbox?: unknown) => {
  const width = asPositiveInteger(rawWidth, DEFAULT_CANVAS_DOCUMENT_WIDTH);
  const height = asPositiveInteger(rawHeight, DEFAULT_CANVAS_DOCUMENT_HEIGHT);
  const bbox = isRecord(rawBbox) ? rawBbox : {};
  return {
    bbox: {
      height: asPositiveInteger(bbox.height, height),
      width: asPositiveInteger(bbox.width, width),
      x: Math.round(asNumber(bbox.x, 0)),
      y: Math.round(asNumber(bbox.y, 0)),
    },
    height,
    width,
  };
};

export const createEmptyCanvasStateV2 = (
  width = DEFAULT_CANVAS_DOCUMENT_WIDTH,
  height = DEFAULT_CANVAS_DOCUMENT_HEIGHT
): CanvasStateContractV2 => ({
  document: createEmptyCanvasDocumentV2(width, height),
  documentRevision: 0,
  snapshots: [],
  stagingArea: createDefaultStagingAreaV2(),
  version: 2,
});

export const createEmptyCanvasDocumentV2 = (
  width = DEFAULT_CANVAS_DOCUMENT_WIDTH,
  height = DEFAULT_CANVAS_DOCUMENT_HEIGHT
): CanvasDocumentContractV2 => {
  const geometry = normalizeCanvasDocumentGeometry(width, height);
  return {
    background: 'transparent',
    ...geometry,
    layers: [],
    selectedLayerId: null,
    version: 2,
  };
};

/**
 * A brand-new project's default inpaint mask: one empty mask (no bitmap/strokes)
 * with the legacy-default diagonal-hatch fill in the first cycled mask colour
 * (legacy `rgb(224,117,117)`). Mirrors `createInpaintMaskLayer` /
 * `DEFAULT_INPAINT_MASK_FILL` in `widgets/layers/layerOps` — duplicated here so
 * the pure reducer/migration module doesn't pull in the layers-panel/engine
 * module graph; `canvasMigration.test.ts` locks the shape against that factory.
 */
const createInitialInpaintMaskLayer = (): CanvasInpaintMaskLayerContract => ({
  blendMode: 'normal',
  id: createMigrationId('layer'),
  isEnabled: true,
  isLocked: false,
  mask: { bitmap: null, fill: { color: '#e07575', style: 'diagonal' } },
  name: 'Inpaint Mask 1',
  opacity: 1,
  transform: { rotation: 0, scaleX: 1, scaleY: 1, x: 0, y: 0 },
  type: 'inpaint_mask',
});

/**
 * A fresh canvas state for a newly created project: an empty document that
 * already carries one empty inpaint mask (selected), matching legacy, which seeds
 * a canvas session with an inpaint mask present. The mask has no content, so it
 * does NOT flip generation-mode detection to inpaint (see `detectCanvasMode`).
 *
 * This is the NEW-canvas path only. The migration / absent-input path
 * (`loadCanvasState`) and `createEmptyCanvasStateV2` stay empty, so existing
 * and migrated documents are left untouched.
 */
export const createNewCanvasStateV2 = (
  width = DEFAULT_CANVAS_DOCUMENT_WIDTH,
  height = DEFAULT_CANVAS_DOCUMENT_HEIGHT
): CanvasStateContractV2 => {
  const base = createEmptyCanvasStateV2(width, height);
  const mask = createInitialInpaintMaskLayer();

  return {
    ...base,
    document: { ...base.document, layers: [mask], selectedLayerId: mask.id },
  };
};

const createDefaultStagingAreaV2 = (): CanvasStagingAreaContractV2 => ({
  areThumbnailsVisible: true,
  autoSwitchMode: 'off',
  isVisible: false,
  pendingImageIds: [],
  pendingImages: [],
  selectedImageIndex: 0,
});

/**
 * Converts a v1 `{x,y,width,height}` placement rect, plus the native size of the image it
 * places, into a v2 `transform`. Shared by the migration path and the live "accept staged
 * image into a raster layer" reducer, which still works from a v1-shaped placement.
 */
export const placementToTransform = (
  placement: { x: number; y: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number
): CanvasLayerBaseContract['transform'] => ({
  rotation: 0,
  scaleX: imageWidth > 0 ? placement.width / imageWidth : 1,
  scaleY: imageHeight > 0 ? placement.height / imageHeight : 1,
  x: placement.x,
  y: placement.y,
});

/** Migrates a single v1 `CanvasRasterLayerContract` (or bare imageName string) into a v2 raster layer. */
const migrateLayerToV2 = (rawLayer: unknown, index: number): CanvasRasterLayerContractV2 => {
  if (typeof rawLayer === 'string') {
    return {
      blendMode: 'normal',
      id: rawLayer || createMigrationId('layer'),
      isEnabled: true,
      isLocked: false,
      name: rawLayer || `Layer ${index + 1}`,
      opacity: 1,
      source: { image: { height: 0, imageName: rawLayer, width: 0 }, type: 'image' },
      transform: { rotation: 0, scaleX: 1, scaleY: 1, x: 0, y: 0 },
      type: 'raster',
    };
  }

  const layer = isRecord(rawLayer) ? rawLayer : {};
  const image: CanvasImageRef = {
    height: asNumber(layer.height, 0),
    imageName: asString(layer.imageName, ''),
    width: asNumber(layer.width, 0),
  };
  const placement = isRecord(layer.placement) ? layer.placement : {};
  const placementX = asNumber(placement.x, 0);
  const placementY = asNumber(placement.y, 0);
  const placementWidth = asNumber(placement.width, image.width);
  const placementHeight = asNumber(placement.height, image.height);
  const placementOpacity = typeof placement.opacity === 'number' ? placement.opacity : 1;

  return {
    blendMode: 'normal',
    id: asString(layer.id, createMigrationId('layer')),
    isEnabled: true,
    isLocked: false,
    name: asString(layer.label, `Layer ${index + 1}`),
    opacity: placementOpacity,
    source: { image, type: 'image' },
    transform: placementToTransform(
      { height: placementHeight, width: placementWidth, x: placementX, y: placementY },
      image.width,
      image.height
    ),
    type: 'raster',
  };
};

const migrateDocumentToV2 = (rawDocument: Record<string, unknown>): CanvasDocumentContractV2 => {
  const rawLayers = Array.isArray(rawDocument.layers) ? rawDocument.layers : [];

  return {
    background: 'transparent',
    ...normalizeCanvasDocumentGeometry(rawDocument.width, rawDocument.height),
    layers: rawLayers.map((rawLayer, index) => migrateLayerToV2(rawLayer, index)),
    selectedLayerId: null,
    version: 2,
  };
};

const AUTO_SWITCH_MODES: CanvasStagingAreaContractV2['autoSwitchMode'][] = ['off', 'latest', 'progress'];

const asAutoSwitchMode = (value: unknown): CanvasStagingAreaContractV2['autoSwitchMode'] =>
  AUTO_SWITCH_MODES.includes(value as CanvasStagingAreaContractV2['autoSwitchMode'])
    ? (value as CanvasStagingAreaContractV2['autoSwitchMode'])
    : 'off';

/**
 * Normalizes a v1 or v2 staging area. v1 never had `autoSwitchMode`, so it's absent from raw
 * input and defaults to `'off'`; already-v2 input keeps its existing value.
 */
const migrateStagingAreaToV2 = (rawCanvas: Record<string, unknown>): CanvasStagingAreaContractV2 => {
  const rawStagingArea = isRecord(rawCanvas.stagingArea) ? rawCanvas.stagingArea : {};
  const defaults = createDefaultStagingAreaV2();

  return {
    areThumbnailsVisible:
      typeof rawStagingArea.areThumbnailsVisible === 'boolean'
        ? rawStagingArea.areThumbnailsVisible
        : defaults.areThumbnailsVisible,
    autoSwitchMode: asAutoSwitchMode(rawStagingArea.autoSwitchMode),
    isVisible: typeof rawStagingArea.isVisible === 'boolean' ? rawStagingArea.isVisible : defaults.isVisible,
    pendingImageIds: Array.isArray(rawStagingArea.pendingImageIds)
      ? (rawStagingArea.pendingImageIds as CanvasStagingAreaContractV2['pendingImageIds'])
      : defaults.pendingImageIds,
    pendingImages: Array.isArray(rawStagingArea.pendingImages)
      ? (rawStagingArea.pendingImages as CanvasStagingAreaContractV2['pendingImages'])
      : defaults.pendingImages,
    selectedImageIndex: asNumber(rawStagingArea.selectedImageIndex, defaults.selectedImageIndex),
    ...(typeof rawStagingArea.selectedLayerId === 'string' ? { selectedLayerId: rawStagingArea.selectedLayerId } : {}),
    ...(typeof rawStagingArea.sourceQueueItemId === 'string'
      ? { sourceQueueItemId: rawStagingArea.sourceQueueItemId }
      : {}),
  };
};

type Refusal =
  | { status: 'unsupported-version'; scope: CanvasVersionScope; version: number }
  | { status: 'invalid'; scope: CanvasVersionScope; diagnostics: readonly CanvasLoadDiagnostic[] };

type LoadStep<T> = Extract<CanvasLoadResult<T>, { status: 'loaded' }> | Refusal;

const LEGACY_CANVAS_VERSION = 1;
const CURRENT_CANVAS_VERSION = 2;

type DeclaredVersion =
  | { kind: 'absent' }
  | { kind: 'legacy' }
  | { kind: 'current' }
  | { kind: 'future'; version: number }
  | { kind: 'malformed' };

const classifyVersion = (value: unknown): DeclaredVersion => {
  if (value === undefined) {
    return { kind: 'absent' };
  }
  if (value === LEGACY_CANVAS_VERSION) {
    return { kind: 'legacy' };
  }
  if (value === CURRENT_CANVAS_VERSION) {
    return { kind: 'current' };
  }
  if (typeof value === 'number' && Number.isInteger(value) && value > CURRENT_CANVAS_VERSION) {
    return { kind: 'future', version: value };
  }
  return { kind: 'malformed' };
};

const describeVersion = (value: unknown): string => (typeof value === 'string' ? JSON.stringify(value) : String(value));

const invalid = (scope: CanvasVersionScope, diagnostics: readonly CanvasLoadDiagnostic[]): Refusal => ({
  diagnostics,
  scope,
  status: 'invalid',
});

const unsupported = (scope: CanvasVersionScope, version: number): Refusal => ({
  scope,
  status: 'unsupported-version',
  version,
});

const describeLayerIssue = (value: Record<string, unknown>, path: string, issues: readonly z.core.$ZodIssue[]) => {
  const issue = issues[0];
  const detail = issue
    ? `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`
    : 'invalid layer';
  const type = typeof value.type === 'string' ? value.type : undefined;
  return { message: type ? `${type} layer is invalid (${detail})` : `layer is invalid (${detail})`, path };
};

type ParsedLayer = { layer: CanvasLayerContract } | { diagnostic: CanvasLoadDiagnostic };

/** Fills the known optional defaults on a v2 layer, then validates it strictly. */
const parseCanvasLayer = (value: unknown, path: string): ParsedLayer => {
  if (!isRecord(value)) {
    return { diagnostic: { message: 'layer is not an object', path } };
  }
  let candidate: Record<string, unknown> = value;
  if (value.type === 'control') {
    candidate = {
      ...value,
      adapter: normalizeControlAdapter(value.adapter),
      withTransparencyEffect: value.withTransparencyEffect === undefined ? true : value.withTransparencyEffect,
    };
  } else if (value.type === 'regional_guidance') {
    candidate = {
      ...value,
      autoNegative: value.autoNegative === undefined ? false : value.autoNegative,
      negativePrompt: value.negativePrompt === undefined ? null : value.negativePrompt,
      positivePrompt: value.positivePrompt === undefined ? null : value.positivePrompt,
      referenceImages: value.referenceImages === undefined ? [] : value.referenceImages,
    };
  }
  const parsed = zCanvasLayer.safeParse(candidate);
  return parsed.success
    ? { layer: candidate as unknown as CanvasLayerContract }
    : { diagnostic: describeLayerIssue(value, path, parsed.error.issues) };
};

type ParsedLayers = { layers: CanvasLayerContract[] } | { diagnostics: CanvasLoadDiagnostic[] };

const parseCanvasLayers = (value: unknown, path: string): ParsedLayers => {
  if (!Array.isArray(value)) {
    return { diagnostics: [{ message: 'layers is not an array', path }] };
  }
  const layers: CanvasLayerContract[] = [];
  const diagnostics: CanvasLoadDiagnostic[] = [];
  value.forEach((entry, index) => {
    const parsed = parseCanvasLayer(entry, `${path}[${index}]`);
    if ('layer' in parsed) {
      layers.push(parsed.layer);
    } else {
      diagnostics.push(parsed.diagnostic);
    }
  });
  return diagnostics.length > 0 ? { diagnostics } : { layers };
};

/** Re-validates an in-memory v2 document, filling known optional defaults; `null` when any layer is invalid. */
export const normalizeCanvasDocumentContract = (
  document: CanvasDocumentContractV2
): CanvasDocumentContractV2 | null => {
  const parsed = parseCanvasLayers(document.layers, 'layers');
  return 'layers' in parsed
    ? {
        ...document,
        ...normalizeCanvasDocumentGeometry(document.width, document.height, document.bbox),
        layers: parsed.layers,
      }
    : null;
};

const loadCanvasDocumentV2 = (
  value: unknown,
  scope: CanvasVersionScope,
  path: string
): LoadStep<CanvasDocumentContractV2> => {
  if (!isRecord(value)) {
    return invalid(scope, [{ message: 'document is not an object', path }]);
  }
  const version = classifyVersion(value.version);
  if (version.kind === 'future') {
    return unsupported(scope, version.version);
  }
  if (version.kind === 'legacy' || version.kind === 'malformed') {
    return invalid(scope, [
      {
        message: `document version ${describeVersion(value.version)} is not valid inside a version 2 canvas`,
        path: `${path}.version`,
      },
    ]);
  }
  const layers = parseCanvasLayers(value.layers === undefined ? [] : value.layers, `${path}.layers`);
  if ('diagnostics' in layers) {
    return invalid(scope, layers.diagnostics);
  }
  return {
    diagnostics: [],
    status: 'loaded',
    value: {
      background:
        value.background === 'transparent' || isRecord(value.background)
          ? (value.background as CanvasDocumentContractV2['background'])
          : 'transparent',
      ...normalizeCanvasDocumentGeometry(value.width, value.height, value.bbox),
      layers: layers.layers,
      selectedLayerId: typeof value.selectedLayerId === 'string' ? value.selectedLayerId : null,
      version: 2,
    },
  };
};

const loadCanvasSnapshot = (value: unknown, path: string): LoadStep<CanvasSnapshotContract> => {
  if (!isRecord(value)) {
    return invalid('snapshot', [{ message: 'snapshot is not an object', path }]);
  }
  const missing = (['id', 'name', 'createdAt'] as const).filter((key) => typeof value[key] !== 'string');
  if (missing.length > 0) {
    return invalid(
      'snapshot',
      missing.map((key) => ({ message: `snapshot ${key} is missing`, path: `${path}.${key}` }))
    );
  }
  const document = loadCanvasDocumentV2(value.document, 'snapshot', `${path}.document`);
  return document.status === 'loaded'
    ? { diagnostics: [], status: 'loaded', value: { ...value, document: document.value } as CanvasSnapshotContract }
    : document;
};

const loadCanvasStateV2 = (canvas: Record<string, unknown>): LoadStep<CanvasStateContractV2> => {
  const document = loadCanvasDocumentV2(canvas.document === undefined ? {} : canvas.document, 'document', 'document');
  if (document.status !== 'loaded') {
    return document;
  }
  const rawSnapshots = canvas.snapshots === undefined ? [] : canvas.snapshots;
  if (!Array.isArray(rawSnapshots)) {
    return invalid('state', [{ message: 'snapshots is not an array', path: 'snapshots' }]);
  }
  const snapshots: CanvasSnapshotContract[] = [];
  for (const [index, rawSnapshot] of rawSnapshots.entries()) {
    const snapshot = loadCanvasSnapshot(rawSnapshot, `snapshots[${index}]`);
    if (snapshot.status !== 'loaded') {
      return snapshot;
    }
    snapshots.push(snapshot.value);
  }
  return {
    diagnostics: [],
    status: 'loaded',
    value: {
      document: document.value,
      documentRevision: asNumber(canvas.documentRevision, 0),
      snapshots,
      stagingArea: migrateStagingAreaToV2(canvas),
      version: 2,
    },
  };
};

const loadLegacyCanvasState = (rawCanvas: Record<string, unknown>): LoadStep<CanvasStateContractV2> => {
  const rawDocument = isRecord(rawCanvas.document) ? rawCanvas.document : rawCanvas;
  if (rawDocument !== rawCanvas) {
    const version = classifyVersion(rawDocument.version);
    if (version.kind === 'future') {
      return unsupported('document', version.version);
    }
    if (version.kind === 'current' || version.kind === 'malformed') {
      return invalid('document', [
        {
          message: `document version ${describeVersion(rawDocument.version)} is not valid inside a legacy canvas`,
          path: 'document.version',
        },
      ]);
    }
  }
  return {
    diagnostics: [{ message: 'migrated legacy canvas state to version 2', path: 'version' }],
    status: 'loaded',
    value: {
      document: migrateDocumentToV2(rawDocument),
      documentRevision: 0,
      snapshots: [],
      stagingArea: migrateStagingAreaToV2(rawCanvas),
      version: 2,
    },
  };
};

const loadCanvasStateStep = (canvas: unknown): LoadStep<CanvasStateContractV2> => {
  if (canvas === undefined || canvas === null) {
    return loadLegacyCanvasState({});
  }
  if (!isRecord(canvas) || Array.isArray(canvas)) {
    return invalid('state', [{ message: 'canvas state is not an object', path: '' }]);
  }
  const version = classifyVersion(canvas.version);
  switch (version.kind) {
    case 'future':
      return unsupported('state', version.version);
    case 'malformed':
      return invalid('state', [
        { message: `canvas version ${describeVersion(canvas.version)} is not recognized`, path: 'version' },
      ]);
    case 'current':
      return loadCanvasStateV2(canvas);
    default:
      return loadLegacyCanvasState(canvas);
  }
};

/**
 * Version-checks persisted canvas state before anything migrates or defaults it: absent and v1
 * state enter the known migration path, v2 is validated strictly, anything newer is refused.
 */
export const loadCanvasState = (canvas: unknown): CanvasLoadResult<CanvasStateContractV2> => {
  const step = loadCanvasStateStep(canvas);
  return step.status === 'loaded' ? step : { ...step, raw: canvas };
};
