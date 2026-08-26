import type { Project } from '@workbench/projectContracts';

import {
  type CanvasDocumentContractV2,
  type CanvasLayerBasePatch,
  type CanvasLayerConfigPatch,
  type CanvasLayerContract,
  type CanvasProjectMutation,
  type CanvasRasterLayerContractV2,
  type CanvasStateContractV2,
  type FlatLayerInsertion,
  type FlatLayerInsertionAnchor,
  type ReorderFlatStackCommand,
  insertLayersAtAnchor,
  isHideableLayer,
  reorderLayerStack,
  repairSelectedLayerId,
} from '@workbench/canvas-engine/api';

import { normalizeCanvasDocumentContract } from './canvasMigration';
import {
  getCanvasStagingCandidateFingerprint,
  getCanvasStagingSlotCount,
  getCanvasStagingSlots,
} from './canvasStagingView';

export type { CanvasLayerBasePatch, CanvasLayerConfigPatch, CanvasProjectMutation } from '@workbench/canvas-engine/api';

const CANVAS_PROJECT_MUTATION_TYPES: ReadonlySet<string> = new Set<CanvasProjectMutation['type']>([
  'commitStagedImage',
  'rollbackStagedImageCommit',
  'addCanvasLayer',
  'applyCanvasLayerStackMutation',
  'clearCanvasStaging',
  'convertCanvasLayer',
  'cycleStagedImage',
  'deleteCanvasSnapshot',
  'discardAllStagedImages',
  'discardSelectedStagedImage',
  'duplicateCanvasLayer',
  'mergeCanvasLayersDown',
  'removeCanvasLayers',
  'reorderCanvasLayerStacks',
  'replaceCanvasDocument',
  'replaceCanvasLayer',
  'resizeCanvasDocument',
  'restoreCanvasSnapshot',
  'saveCanvasSnapshot',
  'setCanvasBbox',
  'setCanvasLayerPositions',
  'setCanvasLayersEnabled',
  'setCanvasLayersHidden',
  'setCanvasSelectedLayer',
  'setCanvasStagingAutoSwitch',
  'setStagedImageIndex',
  'toggleCanvasStagingThumbnailsVisibility',
  'toggleCanvasStagingVisibility',
  'updateCanvasLayer',
  'updateCanvasLayerConfig',
  'updateCanvasLayerSource',
]);

export const isCanvasProjectMutation = (value: { type: string }): value is CanvasProjectMutation =>
  CANVAS_PROJECT_MUTATION_TYPES.has(value.type);

type CanvasLayers = CanvasDocumentContractV2['layers'];

const layerExists = (layers: CanvasLayers, id: string): boolean => layers.some((layer) => layer.id === id);

const AUTO_LAYER_NAME_PATTERN = /^Layer (\d+)$/;

export const nextLayerName = (existingNames: readonly string[]): string => {
  const used = new Set<number>();
  for (const name of existingNames) {
    const match = AUTO_LAYER_NAME_PATTERN.exec(name.trim());
    if (match) {
      const n = Number(match[1]);
      if (Number.isInteger(n) && n > 0) {
        used.add(n);
      }
    }
  }
  let n = 1;
  while (used.has(n)) {
    n += 1;
  }
  return `Layer ${n}`;
};

const withRepairedSelection = (document: CanvasDocumentContractV2): CanvasDocumentContractV2 => {
  const selectedLayerId = repairSelectedLayerId(document.layers, document.selectedLayerId);
  return selectedLayerId === document.selectedLayerId ? document : { ...document, selectedLayerId };
};

const setCanvasDocument = (project: Project, document: CanvasDocumentContractV2): Project =>
  document === project.canvas.document ? project : { ...project, canvas: { ...project.canvas, document } };

const updateCanvasDocument = (
  project: Project,
  update: (document: CanvasDocumentContractV2) => CanvasDocumentContractV2
): Project => setCanvasDocument(project, update(project.canvas.document));

const setCanvasState = (project: Project, canvas: CanvasStateContractV2): Project =>
  canvas === project.canvas ? project : { ...project, canvas };

const mapCanvasLayer = (
  document: CanvasDocumentContractV2,
  id: string,
  update: (layer: CanvasLayerContract) => CanvasLayerContract
): CanvasDocumentContractV2 => {
  let changed = false;
  const layers = document.layers.map((layer) => {
    if (layer.id !== id) {
      return layer;
    }
    const next = update(layer);
    changed ||= next !== layer;
    return next;
  });
  return changed ? { ...document, layers } : document;
};

const setCanvasLayersEnabled = (
  document: CanvasDocumentContractV2,
  updates: readonly { id: string; isEnabled: boolean }[]
): CanvasDocumentContractV2 => {
  const targets = new Map(updates.map((update) => [update.id, update.isEnabled]));
  let changed = false;
  const layers = document.layers.map((layer) => {
    const isEnabled = targets.get(layer.id);
    if (isEnabled === undefined || isEnabled === layer.isEnabled) {
      return layer;
    }
    changed = true;
    return { ...layer, isEnabled };
  });
  return changed ? { ...document, layers } : document;
};

/**
 * Bulk display-visibility update. Layers that cannot be hidden (raster) are
 * skipped rather than silently gaining a meaningless field: for them visibility
 * and participation are the same fact, which `isEnabled` already carries.
 */
const setCanvasLayersHidden = (
  document: CanvasDocumentContractV2,
  updates: readonly { id: string; isHidden: boolean }[]
): CanvasDocumentContractV2 => {
  const targets = new Map(updates.map((update) => [update.id, update.isHidden]));
  let changed = false;
  const layers = document.layers.map((layer) => {
    const isHidden = targets.get(layer.id);
    if (isHidden === undefined || !isHideableLayer(layer) || isHidden === (layer.isHidden === true)) {
      return layer;
    }
    changed = true;
    return { ...layer, isHidden };
  });
  return changed ? { ...document, layers } : document;
};

const setCanvasLayerPositions = (
  document: CanvasDocumentContractV2,
  updates: readonly { id: string; x: number; y: number }[]
): CanvasDocumentContractV2 => {
  const positions = new Map(updates.map((update) => [update.id, update]));
  if (
    positions.size !== updates.length ||
    updates.some(
      (update) => !layerExists(document.layers, update.id) || !Number.isFinite(update.x) || !Number.isFinite(update.y)
    )
  ) {
    return document;
  }
  let changed = false;
  const layers = document.layers.map((layer) => {
    const position = positions.get(layer.id);
    if (!position || (layer.transform.x === position.x && layer.transform.y === position.y)) {
      return layer;
    }
    changed = true;
    return { ...layer, transform: { ...layer.transform, x: position.x, y: position.y } };
  });
  return changed ? { ...document, layers } : document;
};

const isInsertionValid = (projectId: string, insertion: FlatLayerInsertion): boolean =>
  insertion.anchor.projectId === projectId && insertion.layers.every((layer) => layer.type === insertion.anchor.stack);

const applyLayerStackMutation = (
  projectId: string,
  document: CanvasDocumentContractV2,
  mutation: Extract<CanvasProjectMutation, { type: 'applyCanvasLayerStackMutation' }>
): CanvasDocumentContractV2 => {
  const currentIds = new Set(document.layers.map((layer) => layer.id));
  const removeIds = new Set(mutation.removeIds ?? []);
  if ([...removeIds].some((id) => !currentIds.has(id))) {
    return document;
  }
  const projectedIds = new Set(currentIds);
  for (const id of removeIds) {
    projectedIds.delete(id);
  }
  for (const insertion of mutation.add ?? []) {
    if (!isInsertionValid(projectId, insertion)) {
      return document;
    }
    for (const layer of insertion.layers) {
      if (currentIds.has(layer.id) || projectedIds.has(layer.id)) {
        return document;
      }
      projectedIds.add(layer.id);
    }
  }
  if (
    mutation.enabledUpdates.some((update) => !projectedIds.has(update.id)) ||
    (mutation.lockedUpdates?.some((update) => !projectedIds.has(update.id)) ?? false) ||
    (mutation.selectedLayerId !== undefined &&
      mutation.selectedLayerId !== null &&
      !projectedIds.has(mutation.selectedLayerId))
  ) {
    return document;
  }
  let layers: CanvasLayers = document.layers;
  let changed = false;
  for (const insertion of mutation.add ?? []) {
    if (insertion.layers.length > 0) {
      layers = insertLayersAtAnchor(layers, insertion.anchor, insertion.layers);
      changed = true;
    }
  }
  if (removeIds.size > 0) {
    layers = layers.filter((layer) => !removeIds.has(layer.id));
    changed = true;
  }
  const enabledById = new Map(mutation.enabledUpdates.map((update) => [update.id, update.isEnabled]));
  const lockedById = new Map(mutation.lockedUpdates?.map((update) => [update.id, update.isLocked]) ?? []);
  let baseChanged = false;
  const nextLayers = layers.map((layer) => {
    const isEnabled = enabledById.get(layer.id);
    const isLocked = lockedById.get(layer.id);
    const enabledChanged = isEnabled !== undefined && isEnabled !== layer.isEnabled;
    const lockedChanged = isLocked !== undefined && isLocked !== layer.isLocked;
    if (!enabledChanged && !lockedChanged) {
      return layer;
    }
    baseChanged = true;
    changed = true;
    return {
      ...layer,
      ...(enabledChanged ? { isEnabled: isEnabled as boolean } : {}),
      ...(lockedChanged ? { isLocked: isLocked as boolean } : {}),
    };
  });
  if (baseChanged) {
    layers = nextLayers;
  }
  const selectedLayerId =
    mutation.selectedLayerId === undefined
      ? repairSelectedLayerId(layers, document.selectedLayerId, document.layers)
      : mutation.selectedLayerId;
  changed ||= document.selectedLayerId !== selectedLayerId;
  return changed
    ? {
        ...document,
        layers,
        selectedLayerId,
      }
    : document;
};

const addLayer = (
  projectId: string,
  document: CanvasDocumentContractV2,
  layer: CanvasLayerContract,
  anchor: FlatLayerInsertionAnchor
): CanvasDocumentContractV2 => {
  if (
    !isInsertionValid(projectId, { anchor, layers: [layer] }) ||
    document.layers.some((candidate) => candidate.id === layer.id)
  ) {
    return document;
  }
  return {
    ...document,
    layers: insertLayersAtAnchor(document.layers, anchor, [layer]),
    selectedLayerId: layer.id,
  };
};

const removeLayers = (document: CanvasDocumentContractV2, ids: readonly string[]): CanvasDocumentContractV2 => {
  const removed = new Set(ids);
  const layers = document.layers.filter((layer) => !removed.has(layer.id));
  if (layers.length === document.layers.length) {
    return document;
  }
  const selectedLayerId = repairSelectedLayerId(layers, document.selectedLayerId, document.layers);
  return { ...document, layers, selectedLayerId };
};

const duplicateLayer = (document: CanvasDocumentContractV2, sourceId: string, newId: string) => {
  const index = document.layers.findIndex((layer) => layer.id === sourceId);
  if (index === -1) {
    return document;
  }
  const source = document.layers[index] as CanvasLayerContract;
  const duplicate = structuredClone(source);
  duplicate.id = newId;
  duplicate.name = `${source.name} copy`;
  return {
    ...document,
    layers: [...document.layers.slice(0, index), duplicate, ...document.layers.slice(index)],
    selectedLayerId: newId,
  };
};

const reorderLayerStacks = (
  document: CanvasDocumentContractV2,
  stacks: readonly ReorderFlatStackCommand[]
): CanvasDocumentContractV2 => {
  if (new Set(stacks.map((command) => command.stack)).size !== stacks.length) {
    return document;
  }
  let layers: CanvasLayers = document.layers;
  for (const command of stacks) {
    const next = reorderLayerStack(layers, command);
    if (!next) {
      return document;
    }
    layers = next;
  }
  return layers.every((layer, index) => layer === document.layers[index]) ? document : { ...document, layers };
};

const patchLayer = (layer: CanvasLayerContract, patch: CanvasLayerBasePatch): CanvasLayerContract => {
  const { transform, ...rest } = patch;
  return { ...layer, ...rest, transform: transform ? { ...layer.transform, ...transform } : layer.transform };
};

const patchLayerConfig = (layer: CanvasLayerContract, config: CanvasLayerConfigPatch): CanvasLayerContract => {
  if (layer.type !== config.layerType) {
    return layer;
  }
  if (layer.type === 'raster' && config.layerType === 'raster') {
    return {
      ...layer,
      ...(Object.hasOwn(config, 'adjustments') ? { adjustments: config.adjustments } : {}),
      ...(Object.hasOwn(config, 'isTransparencyLocked') ? { isTransparencyLocked: config.isTransparencyLocked } : {}),
      ...(Object.hasOwn(config, 'filter') ? { filter: config.filter } : {}),
    };
  }
  if (layer.type === 'control' && config.layerType === 'control') {
    return {
      ...layer,
      ...(config.adapter ? { adapter: { ...layer.adapter, ...config.adapter } } : {}),
      ...(Object.hasOwn(config, 'withTransparencyEffect')
        ? { withTransparencyEffect: config.withTransparencyEffect }
        : {}),
      ...(Object.hasOwn(config, 'filter') ? { filter: config.filter } : {}),
    };
  }
  if (layer.type === 'regional_guidance' && config.layerType === 'regional_guidance') {
    return {
      ...layer,
      ...(config.mask ? { mask: { ...layer.mask, ...config.mask } } : {}),
      ...(Object.hasOwn(config, 'positivePrompt') ? { positivePrompt: config.positivePrompt } : {}),
      ...(Object.hasOwn(config, 'negativePrompt') ? { negativePrompt: config.negativePrompt } : {}),
      ...(Object.hasOwn(config, 'autoNegative') ? { autoNegative: config.autoNegative } : {}),
      ...(Object.hasOwn(config, 'referenceImages') ? { referenceImages: config.referenceImages } : {}),
    };
  }
  if (layer.type === 'inpaint_mask' && config.layerType === 'inpaint_mask') {
    return {
      ...layer,
      ...(config.mask ? { mask: { ...layer.mask, ...config.mask } } : {}),
      ...(Object.hasOwn(config, 'noiseLevel') ? { noiseLevel: config.noiseLevel } : {}),
      ...(Object.hasOwn(config, 'denoiseLimit') ? { denoiseLimit: config.denoiseLimit } : {}),
    };
  }
  return layer;
};

const clampBbox = (bbox: CanvasDocumentContractV2['bbox'], width: number, height: number) => {
  const clampedWidth = Math.min(Math.max(1, Math.round(bbox.width)), width);
  const clampedHeight = Math.min(Math.max(1, Math.round(bbox.height)), height);
  return {
    height: clampedHeight,
    width: clampedWidth,
    x: Math.min(Math.max(0, Math.round(bbox.x)), width - clampedWidth),
    y: Math.min(Math.max(0, Math.round(bbox.y)), height - clampedHeight),
  };
};

const clearStagingArea = (stagingArea: CanvasStateContractV2['stagingArea']) => ({
  ...stagingArea,
  isVisible: false,
  pendingImageIds: [],
  pendingImages: [],
  selectedImageIndex: 0,
  sourceQueueItemId: undefined,
});

const clampStagedImageIndex = (imageIndex: number, slotCount: number): number =>
  Math.min(Math.max(0, slotCount - 1), Math.max(0, imageIndex));

const selectedCandidate = (project: Project) => {
  const slot = getCanvasStagingSlots(project.canvas, project.queue.items)[
    project.canvas.stagingArea.selectedImageIndex
  ];
  return slot?.kind === 'candidate' ? slot.candidate : undefined;
};

export const applyCanvasProjectMutation = (project: Project, mutation: CanvasProjectMutation): Project => {
  switch (mutation.type) {
    case 'commitStagedImage': {
      const stagedImage = selectedCandidate(project);
      if (
        project.canvas.stagingArea.selectedImageIndex !== mutation.selectedImageIndex ||
        !stagedImage ||
        getCanvasStagingCandidateFingerprint(stagedImage) !== mutation.candidateFingerprint
      ) {
        return project;
      }
      const { anchor, layer } = mutation;
      if (
        !isInsertionValid(project.id, { anchor, layers: [layer] }) ||
        project.canvas.document.layers.some((candidate) => candidate.id === layer.id)
      ) {
        return project;
      }
      const selectedLayerId = mutation.continueStaging ? project.canvas.document.selectedLayerId : layer.id;
      return {
        ...project,
        canvas: {
          ...project.canvas,
          document: {
            ...project.canvas.document,
            layers: insertLayersAtAnchor(project.canvas.document.layers, anchor, [layer]),
            selectedLayerId,
          },
          stagingArea: mutation.continueStaging
            ? project.canvas.stagingArea
            : clearStagingArea(project.canvas.stagingArea),
        },
        events: [mutation.event, ...project.events],
      };
    }
    case 'rollbackStagedImageCommit': {
      const expectedSelectedLayerId = mutation.continueStaging ? mutation.selectedLayerId : mutation.layer.id;
      const stagingMatchesCommit = mutation.continueStaging
        ? project.canvas.stagingArea === mutation.stagingArea
        : project.canvas.stagingArea.pendingImages.length === 0;
      if (
        project.canvas.document.selectedLayerId !== expectedSelectedLayerId ||
        !project.canvas.document.layers.includes(mutation.layer) ||
        project.events[0] !== mutation.event ||
        !stagingMatchesCommit
      ) {
        return project;
      }
      return {
        ...project,
        canvas: {
          ...project.canvas,
          document: {
            ...project.canvas.document,
            layers: project.canvas.document.layers.filter((layer) => layer !== mutation.layer),
            selectedLayerId: mutation.selectedLayerId,
          },
          stagingArea: mutation.stagingArea,
        },
        events: project.events.slice(1),
      };
    }
    case 'setStagedImageIndex': {
      const selectedImageIndex = clampStagedImageIndex(
        mutation.imageIndex,
        getCanvasStagingSlotCount(project.canvas, project.queue.items)
      );
      return selectedImageIndex === project.canvas.stagingArea.selectedImageIndex
        ? project
        : {
            ...project,
            canvas: {
              ...project.canvas,
              stagingArea: { ...project.canvas.stagingArea, selectedImageIndex },
            },
          };
    }
    case 'cycleStagedImage': {
      const count = getCanvasStagingSlotCount(project.canvas, project.queue.items);
      const current = project.canvas.stagingArea.selectedImageIndex;
      const selectedImageIndex = count < 2 ? 0 : (current + mutation.direction + count) % count;
      return selectedImageIndex === current
        ? project
        : {
            ...project,
            canvas: {
              ...project.canvas,
              stagingArea: { ...project.canvas.stagingArea, selectedImageIndex },
            },
          };
    }
    case 'discardSelectedStagedImage': {
      const selected = selectedCandidate(project);
      if (!selected) {
        return project;
      }
      const pendingImages = project.canvas.stagingArea.pendingImages.filter(
        (image) => image.sourceQueueItemId !== selected.sourceQueueItemId || image.imageName !== selected.imageName
      );
      const canvas = {
        ...project.canvas,
        stagingArea: {
          ...project.canvas.stagingArea,
          pendingImageIds: pendingImages.map((image) => image.imageName),
          pendingImages,
        },
      };
      const slotCount = getCanvasStagingSlotCount(canvas, project.queue.items);
      return {
        ...project,
        canvas: {
          ...canvas,
          stagingArea: {
            ...canvas.stagingArea,
            isVisible: slotCount > 0 && canvas.stagingArea.isVisible,
            selectedImageIndex: clampStagedImageIndex(canvas.stagingArea.selectedImageIndex, slotCount),
            sourceQueueItemId: pendingImages.length > 0 ? canvas.stagingArea.sourceQueueItemId : undefined,
          },
        },
      };
    }
    case 'discardAllStagedImages': {
      const canvas = { ...project.canvas, stagingArea: clearStagingArea(project.canvas.stagingArea) };
      return {
        ...project,
        canvas: {
          ...canvas,
          stagingArea: {
            ...canvas.stagingArea,
            isVisible: getCanvasStagingSlotCount(canvas, project.queue.items) > 0,
          },
        },
      };
    }
    case 'toggleCanvasStagingVisibility':
      return getCanvasStagingSlotCount(project.canvas, project.queue.items) === 0
        ? project
        : {
            ...project,
            canvas: {
              ...project.canvas,
              stagingArea: {
                ...project.canvas.stagingArea,
                isVisible: !project.canvas.stagingArea.isVisible,
              },
            },
          };
    case 'toggleCanvasStagingThumbnailsVisibility':
      return getCanvasStagingSlotCount(project.canvas, project.queue.items) === 0
        ? project
        : {
            ...project,
            canvas: {
              ...project.canvas,
              stagingArea: {
                ...project.canvas.stagingArea,
                areThumbnailsVisible: !project.canvas.stagingArea.areThumbnailsVisible,
              },
            },
          };
    case 'clearCanvasStaging':
      return { ...project, canvas: { ...project.canvas, stagingArea: clearStagingArea(project.canvas.stagingArea) } };
    case 'addCanvasLayer':
      return updateCanvasDocument(project, (document) =>
        addLayer(project.id, document, mutation.layer, mutation.anchor)
      );
    case 'applyCanvasLayerStackMutation':
      return updateCanvasDocument(project, (document) => applyLayerStackMutation(project.id, document, mutation));
    case 'removeCanvasLayers':
      return updateCanvasDocument(project, (document) => removeLayers(document, mutation.ids));
    case 'duplicateCanvasLayer':
      return updateCanvasDocument(project, (document) => duplicateLayer(document, mutation.sourceId, mutation.newId));
    case 'reorderCanvasLayerStacks':
      return updateCanvasDocument(project, (document) => reorderLayerStacks(document, mutation.stacks));
    case 'updateCanvasLayer':
      return updateCanvasDocument(project, (document) =>
        mapCanvasLayer(document, mutation.id, (layer) => patchLayer(layer, mutation.patch))
      );
    case 'replaceCanvasLayer':
      return updateCanvasDocument(project, (document) =>
        mapCanvasLayer(document, mutation.layerId, () => mutation.layer)
      );
    case 'setCanvasLayersEnabled':
      return updateCanvasDocument(project, (document) => setCanvasLayersEnabled(document, mutation.updates));
    case 'setCanvasLayerPositions':
      return updateCanvasDocument(project, (document) => setCanvasLayerPositions(document, mutation.updates));
    case 'setCanvasLayersHidden':
      return updateCanvasDocument(project, (document) => setCanvasLayersHidden(document, mutation.updates));
    case 'updateCanvasLayerSource':
      return updateCanvasDocument(project, (document) =>
        mapCanvasLayer(document, mutation.id, (layer) =>
          layer.type === 'raster' || layer.type === 'control' ? { ...layer, source: mutation.source } : layer
        )
      );
    case 'updateCanvasLayerConfig':
      return updateCanvasDocument(project, (document) =>
        mapCanvasLayer(document, mutation.id, (layer) => patchLayerConfig(layer, mutation.config))
      );
    case 'convertCanvasLayer': {
      if (mutation.layer.type !== mutation.targetType || !layerExists(project.canvas.document.layers, mutation.id)) {
        return project;
      }
      const converted = structuredClone(mutation.layer);
      converted.id = mutation.id;
      return updateCanvasDocument(project, (document) => mapCanvasLayer(document, mutation.id, () => converted));
    }
    case 'mergeCanvasLayersDown': {
      const document = project.canvas.document;
      const upperIndex = document.layers.findIndex((layer) => layer.id === mutation.upperLayerId);
      const below = upperIndex === -1 ? undefined : document.layers[upperIndex + 1];
      if (!below) {
        return project;
      }
      const merged: CanvasRasterLayerContractV2 = {
        blendMode: below.blendMode,
        id: below.id,
        isEnabled: below.isEnabled,
        isLocked: below.isLocked,
        name: below.name,
        opacity: below.opacity,
        source: mutation.source,
        transform: below.transform,
        type: 'raster',
      };
      const layers = document.layers
        .filter((_, index) => index !== upperIndex)
        .map((layer) => (layer.id === below.id ? merged : layer));
      return setCanvasDocument(project, {
        ...document,
        layers,
        selectedLayerId: repairSelectedLayerId(layers, document.selectedLayerId, document.layers),
      });
    }
    case 'setCanvasBbox':
      return updateCanvasDocument(project, (document) => ({
        ...document,
        bbox: {
          height: Math.max(1, Math.round(mutation.bbox.height)),
          width: Math.max(1, Math.round(mutation.bbox.width)),
          x: Math.round(mutation.bbox.x),
          y: Math.round(mutation.bbox.y),
        },
      }));
    case 'setCanvasSelectedLayer':
      return updateCanvasDocument(project, (document) =>
        mutation.id !== null && !layerExists(document.layers, mutation.id)
          ? document
          : document.selectedLayerId === mutation.id
            ? document
            : { ...document, selectedLayerId: mutation.id }
      );
    case 'resizeCanvasDocument': {
      const width = Math.max(1, Math.round(mutation.width));
      const height = Math.max(1, Math.round(mutation.height));
      const offsetX = mutation.offsetX ?? 0;
      const offsetY = mutation.offsetY ?? 0;
      return updateCanvasDocument(project, (document) => ({
        ...document,
        bbox: clampBbox(
          { ...document.bbox, x: document.bbox.x + offsetX, y: document.bbox.y + offsetY },
          width,
          height
        ),
        height,
        layers:
          offsetX === 0 && offsetY === 0
            ? document.layers
            : document.layers.map((layer) => ({
                ...layer,
                transform: { ...layer.transform, x: layer.transform.x + offsetX, y: layer.transform.y + offsetY },
              })),
        width,
      }));
    }
    case 'replaceCanvasDocument': {
      const document = normalizeCanvasDocumentContract(structuredClone(mutation.document));
      return document
        ? setCanvasState(project, {
            ...project.canvas,
            document: withRepairedSelection(document),
            documentRevision: project.canvas.documentRevision + 1,
            stagingArea: clearStagingArea(project.canvas.stagingArea),
          })
        : project;
    }
    case 'saveCanvasSnapshot': {
      const document = normalizeCanvasDocumentContract(structuredClone(project.canvas.document));
      return document
        ? setCanvasState(project, {
            ...project.canvas,
            snapshots: [
              ...project.canvas.snapshots,
              { createdAt: mutation.createdAt, document, id: mutation.id, name: mutation.name },
            ],
          })
        : project;
    }
    case 'restoreCanvasSnapshot': {
      const snapshot = project.canvas.snapshots.find((entry) => entry.id === mutation.snapshotId);
      const document = snapshot ? normalizeCanvasDocumentContract(structuredClone(snapshot.document)) : null;
      return document
        ? setCanvasState(project, {
            ...project.canvas,
            document: withRepairedSelection(document),
            documentRevision: project.canvas.documentRevision + 1,
          })
        : project;
    }
    case 'deleteCanvasSnapshot': {
      const snapshots = project.canvas.snapshots.filter((entry) => entry.id !== mutation.snapshotId);
      return snapshots.length === project.canvas.snapshots.length
        ? project
        : setCanvasState(project, { ...project.canvas, snapshots });
    }
    case 'setCanvasStagingAutoSwitch':
      return project.canvas.stagingArea.autoSwitchMode === mutation.mode
        ? project
        : {
            ...project,
            canvas: {
              ...project.canvas,
              stagingArea: { ...project.canvas.stagingArea, autoSwitchMode: mutation.mode },
            },
          };
  }
};
