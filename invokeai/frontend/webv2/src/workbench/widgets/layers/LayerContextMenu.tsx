import type {
  CanvasDocumentContractV3,
  CanvasLayerContract,
  CanvasMaskContract,
  BooleanRasterOperation,
  LayerStackMoveKind,
  RegionalGuidanceReferenceImage,
} from '@workbench/canvas-engine/api';
import type { CanvasProjectMutation } from '@workbench/canvasProjectMutations';
import type { CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';
import type { LucideIcon } from 'lucide-react';
import type { ComponentProps, Dispatch, ReactNode } from 'react';

import { HStack, Icon, Menu, Portal, Text } from '@chakra-ui/react';
import { galleryTransfers } from '@features/gallery';
import { useModelsSelector } from '@features/models';
import { IconButton, MenuContent, RenameDialog, Tooltip } from '@platform/ui';
import {
  getDocumentLayer,
  getSourceContentRect,
  isNodeHidden,
  lookupDocumentNodeState,
  renderableSourceOf,
} from '@workbench/canvas-engine/api';
import { getCanvasOperations } from '@workbench/canvas-operations/api';
import { publishLayerPanelSelection, readLayerPanelState, useLayerPanelState } from '@workbench/layerPanelState';
import { useNotify } from '@workbench/useNotify';
import { isCanvasInteractionLocked } from '@workbench/widgets/canvas/canvasInteractionLock';
import { useCanvasDocumentEditingLocked, useLayerThumbnailVersion } from '@workbench/widgets/canvas/engineStoreHooks';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { useActiveProjectId, useActiveProjectSelector, useWorkbenchCommands } from '@workbench/WorkbenchContext';
import {
  ArrowRightLeftIcon,
  ArrowUpDownIcon,
  ChevronRightIcon,
  CopyIcon,
  MergeIcon,
  MoreVerticalIcon,
  PlusIcon,
} from 'lucide-react';
import { Fragment, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type LayerContextMenuEngine = Pick<
  CanvasEngineHandle,
  'document' | 'exports' | 'interaction' | 'layers' | 'projectId' | 'tools'
>;

import type {
  LayerContextMenuItem,
  LayerContextMenuRenderEntry,
  LayerContextMenuSection,
  LayerContextSubmenuId,
} from './layerContextMenuLayout';
import type { LayerMenuDialogKind, LayerMenuDialogState } from './layerMenuState';
import type { LayerPropertiesSection } from './layerPropertiesRequestStore';

import { resolveDefaultControlModelForBase } from './controlModelOptions';
import {
  actionTargets,
  getLayerContextActions,
  type LayerConfigPatchKind,
  type LayerContextAction,
  type LayerContextActionEffects,
  type LayerContextActionId,
  type LayerContextActionState,
  type LayerType,
} from './layerContextActions';
import {
  getLayerContextMenuGroupLayout,
  getLayerContextMenuLayerLabelKey,
  getLayerContextMenuLayout,
  getLayerContextMenuRenderEntries,
} from './layerContextMenuLayout';
import { copyBlobToClipboard, saveLayerToAssets } from './layerExportActions';
import { canGroupSelection, groupLayers } from './layerGroupCommands';
import { resolveMenuTargetForRender } from './layerMenuState';
import {
  convertRasterToControl,
  convertRasterToInpaintMask,
  convertRasterToRegionalGuidance,
  convertRasterControlLayer,
  copyControlToInpaintMask,
  copyControlToRaster,
  copyControlToRegionalGuidance,
  copyMaskToRegionalGuidance,
  copyRasterToControl,
  copyRasterToInpaintMask,
  copyRasterToRegionalGuidance,
  copyRegionalGuidanceToInpaintMask,
  createLayerId,
  fitLayerTransformToBbox,
  getControlTransparencyEffectPatch,
  getInpaintDenoiseLimitPatch,
  getInpaintNoisePatch,
  getRegionalGuidanceAutoNegativePatch,
  getRegionalGuidanceNegativePromptPatch,
  getRegionalGuidancePositivePromptPatch,
  getRegionalGuidanceReferenceImagePatch,
} from './layerOps';
import { requestLayerProperties } from './layerPropertiesRequestStore';
import { RunLayerWorkflowDialog, useLayerWorkflowAvailability } from './RunLayerWorkflowDialog';
import { useSelectedModelBase } from './useSelectedModelBase';

type MenuPositioning = ComponentProps<typeof Menu.Root>['positioning'];
type MenuOpenChange = ComponentProps<typeof Menu.Root>['onOpenChange'];

type LayerConfigPatch =
  | { layerType: 'control'; withTransparencyEffect?: boolean }
  | {
      layerType: 'regional_guidance';
      mask?: Partial<CanvasMaskContract>;
      positivePrompt?: string | null;
      negativePrompt?: string | null;
      autoNegative?: boolean;
      referenceImages?: RegionalGuidanceReferenceImage[];
    }
  | { layerType: 'inpaint_mask'; noiseLevel?: number; denoiseLimit?: number };

const PANEL_POSITIONING: MenuPositioning = { placement: 'bottom-end' };

const toErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const assertNever = (value: never): never => {
  throw new Error(`Unhandled layer action result: ${String(value)}`);
};

type LayerActionErrorStatus =
  | 'aborted'
  | 'busy'
  | 'disabled'
  | 'empty'
  | 'locked'
  | 'missing'
  | 'not-ready'
  | 'over-budget'
  | 'unsupported';

const LAYER_ACTION_ERROR_KEYS: Record<LayerActionErrorStatus, string> = {
  aborted: 'widgets.layers.actions.notReady',
  busy: 'widgets.layers.actions.busy',
  disabled: 'widgets.layers.actions.disabled',
  empty: 'widgets.layers.actions.empty',
  locked: 'widgets.layers.actions.locked',
  missing: 'widgets.layers.actions.missing',
  'not-ready': 'widgets.layers.actions.notReady',
  'over-budget': 'widgets.layers.actions.notReady',
  unsupported: 'widgets.layers.actions.unsupported',
};

const hasPureExportableLayerContent = (layer: CanvasLayerContract, document: CanvasDocumentContractV3): boolean => {
  if (!renderableSourceOf(layer)) {
    return false;
  }
  const contentRect = getSourceContentRect(layer, document);
  return contentRect.width > 0 && contentRect.height > 0;
};

interface LayerMenuProps {
  dispatch: Dispatch<CanvasProjectMutation>;
  engine: LayerContextMenuEngine | null;
  layer: CanvasLayerContract;
  /** Where the menu opens: the panel anchors to its trigger; the canvas uses a
   * virtual rect at the cursor. */
  positioning: MenuPositioning;
  /** Render the panel's ⋯ trigger button. Off in the canvas' controlled, anchored
   * mode, where there is no trigger DOM. */
  withTrigger?: boolean;
  /** Controlled open state (canvas right-click). Undefined ⇒ uncontrolled (panel). */
  open?: boolean;
  onOpenChange?: MenuOpenChange;
  lazyMount?: boolean;
  unmountOnExit?: boolean;
  /**
   * Controlled sibling-dialog state. When provided (canvas right-click), the
   * parent owns it so dialogs survive the menu closing. Undefined means the menu
   * keeps this state internally (panel).
   */
  dialogKind?: LayerMenuDialogKind | null;
  onDialogKindChange?: (kind: LayerMenuDialogKind | null) => void;
  /** Canvas-only items composed immediately before the terminal danger section. */
  beforeDangerItems?: ReactNode;
  /** Adds the legacy layer and Canvas group labels on the canvas surface. */
  showGroupLabels?: boolean;
}

/**
 * The shared layer context menu: one source of truth for the per-layer items,
 * used by both the layers panel (⋯ trigger) and the canvas surface (right-click).
 * All actions operate on `layer.id`, so they behave identically from either.
 *
 * Arrange actions are group-aware (within the layer's type group) and map to a
 * splice inside the global array, while merge-down uses global z-adjacency.
 *
 * Sibling dialogs live beside `Menu.Root` rather than inside its portal, so they
 * survive the menu closing after their action is chosen.
 */
const LayerMenu = ({
  dispatch,
  engine,
  layer,
  positioning,
  withTrigger,
  open,
  onOpenChange,
  lazyMount,
  unmountOnExit,
  dialogKind: controlledDialogKind,
  onDialogKindChange,
  beforeDangerItems,
  showGroupLabels,
}: LayerMenuProps) => {
  const commitPrepared = usePreparedCommit(engine);
  const { t } = useTranslation();
  const projectId = useActiveProjectId();
  const { widgets } = useWorkbenchCommands();
  const notify = useNotify();
  const base = useSelectedModelBase();
  const models = useModelsSelector((snapshot) => snapshot.models);
  const defaultControlModel = useMemo(() => resolveDefaultControlModelForBase(models, base), [base, models]);
  const workflowAvailability = useLayerWorkflowAvailability();
  const canvas = useActiveProjectSelector((project) => project.canvas);
  const queueItems = useActiveProjectSelector((project) => project.queue.items);
  const { document } = canvas;
  const { bbox } = document;
  const documentRect = useMemo(
    () => ({ height: document.height, width: document.width, x: 0, y: 0 }),
    [document.height, document.width]
  );
  const documentEditingLocked = useCanvasDocumentEditingLocked(engine);
  const { selectedIds } = useLayerPanelState(projectId, document.selectedLayerId);
  const interactionLocked = isCanvasInteractionLocked(canvas, queueItems) || documentEditingLocked;
  // Re-render when live, not-yet-persisted paint/mask pixels change.
  useLayerThumbnailVersion(engine, layer.id);
  const hasSupportedContent = engine
    ? engine.exports.hasExportableLayerContent(layer.id)
    : hasPureExportableLayerContent(layer, document);
  const [internalDialogKind, setInternalDialogKind] = useState<LayerMenuDialogKind | null>(null);
  // Controlled (canvas) vs. uncontrolled (panel): the canvas parent owns the
  // dialog kind so its sibling survives menu close; panel rows keep it locally.
  const dialogKind = controlledDialogKind !== undefined ? controlledDialogKind : internalDialogKind;
  const setDialogKind = useCallback(
    (next: LayerMenuDialogKind | null) => {
      setInternalDialogKind(next);
      onDialogKindChange?.(next);
    },
    [onDialogKindChange]
  );

  const patchBase = useCallback(
    (label: string, forward: Partial<CanvasLayerContract>) => {
      commitPrepared(label, (model) => model.prepare({ id: layer.id, patch: forward, type: 'patch' }));
    },
    [commitPrepared, layer.id]
  );

  const patchConfig = useCallback(
    (label: string, forward: LayerConfigPatch) => {
      commitPrepared(label, (model) => model.prepare({ config: forward, id: layer.id, type: 'patch-config' }));
    },
    [commitPrepared, layer.id]
  );

  const reorder = useCallback(
    (kind: LayerStackMoveKind, label: string) => {
      commitPrepared(label, (model) => model.prepare({ ids: [layer.id], kind, type: 'move' }));
    },
    [commitPrepared, layer.id]
  );

  const canGroup = canGroupSelection(engine?.document.model() ?? null, actionTargets({ layer, selectedIds }));
  const hiddenByAncestor =
    (lookupDocumentNodeState(document, layer.id)?.documentHidden ?? false) && !isNodeHidden(layer);
  const actionState = useMemo<LayerContextActionState>(
    () => ({
      canGroupSelection: canGroup,
      hiddenByAncestor,
      canRunWorkflow: workflowAvailability.canRunWorkflow,
      document,
      hasEngine: engine !== null,
      hasSupportedContent,
      hasWorkflowBindings: workflowAvailability.hasWorkflowBindings,
      interactionLocked,
      layer,
      selectedIds,
    }),
    [
      hiddenByAncestor,
      canGroup,
      document,
      engine,
      hasSupportedContent,
      interactionLocked,
      layer,
      selectedIds,
      workflowAvailability.canRunWorkflow,
      workflowAvailability.hasWorkflowBindings,
    ]
  );
  const actions = useMemo(() => getLayerContextActions(actionState), [actionState]);
  const menuLayout = useMemo(() => getLayerContextMenuLayout(actions), [actions]);

  const getActionLabel = useCallback(
    (id: LayerContextActionId) => {
      if (id === 'duplicate') {
        const panelSelection = readLayerPanelState(projectId, document.selectedLayerId);
        if (panelSelection.selectedIds.includes(layer.id) && panelSelection.selectedIds.length > 1) {
          return t('widgets.layers.actions.duplicateSelected');
        }
      }
      const action = actions.find((entry) => entry.id === id);
      return action ? t(action.labelKey, { defaultValue: action.defaultLabel }) : id;
    },
    [actions, document.selectedLayerId, layer.id, projectId, t]
  );

  const makeStatusError = useCallback(
    (status: LayerActionErrorStatus): Error => new Error(t(LAYER_ACTION_ERROR_KEYS[status])),
    [t]
  );

  const handleDuplicate = useCallback(async () => {
    if (engine) {
      const panelSelection = readLayerPanelState(projectId, document.selectedLayerId);
      const sourceIds = panelSelection.selectedIds.includes(layer.id) ? panelSelection.selectedIds : [layer.id];
      try {
        const result = await engine.layers.duplicateLayers(sourceIds);
        if (result.status === 'duplicated') {
          publishLayerPanelSelection({
            primaryId: result.selectedLayerId,
            projectId,
            selectedIds: result.duplicateIds,
          });
          return;
        }
        if (result.status === 'busy') {
          return;
        }
      } catch {
        // A rejected engine transaction leaves the document unchanged; report
        // the failure through the menu instead of leaking an event exception.
      }
      notify.error(t('widgets.layers.actions.actionFailed'), t('widgets.layers.actions.copyFailed'));
      return;
    }
    commitPrepared(t('widgets.layers.actions.duplicate'), (model) =>
      model.prepare({ createId: createLayerId, ids: [layer.id], type: 'duplicate' })
    );
  }, [commitPrepared, document.selectedLayerId, engine, layer.id, notify, projectId, t]);

  const handleDelete = useCallback(() => {
    commitPrepared(t('widgets.layers.actions.delete'), (model) => model.prepare({ ids: [layer.id], type: 'remove' }));
  }, [commitPrepared, layer.id, t]);

  const handleGroup = useCallback(() => {
    const ids = actionTargets({ layer, selectedIds });
    const outcome = groupLayers(engine, projectId, ids, t('widgets.layers.actions.group'));
    if (outcome.status === 'refused') {
      throw makeStatusError(outcome.refusal.status === 'locked' ? 'locked' : 'unsupported');
    }
  }, [engine, layer, makeStatusError, projectId, selectedIds, t]);

  const handleMerge = useCallback(() => {
    // Pixel work: engine-only, and not recorded on the undo history.
    engine?.layers.mergeLayerDown(layer.id);
  }, [engine, layer.id]);

  const handleRasterize = useCallback(() => {
    // Bakes the parametric source to pixels; the engine records ONE undoable
    // entry (inverse re-converts to the parametric source).
    engine?.layers.rasterizeLayer(layer.id);
  }, [engine, layer.id]);

  const addCopy = useCallback(
    (copied: CanvasLayerContract | null, label: string) => {
      if (!copied) {
        throw new Error(t('widgets.layers.actions.copyFailed'));
      }
      if (
        !engine?.layers.commitLayerCopy(
          label,
          layer.id,
          copied,
          engine.document.captureInsertionAnchor(copied.type, layer.id)
        )
      ) {
        throw new Error(t('widgets.layers.actions.copyFailed'));
      }
    },
    [engine, layer.id, t]
  );

  const convert = useCallback(
    (targetType: CanvasLayerContract['type'], label: string) => {
      const converted =
        layer.type === 'raster' && targetType === 'control'
          ? convertRasterToControl(layer, base, defaultControlModel)
          : layer.type === 'raster' && targetType === 'inpaint_mask'
            ? convertRasterToInpaintMask(layer)
            : layer.type === 'raster' && targetType === 'regional_guidance'
              ? convertRasterToRegionalGuidance(layer)
              : targetType === 'raster'
                ? convertRasterControlLayer(layer, 'raster')
                : null;
      if (!converted) {
        throw makeStatusError('unsupported');
      }
      // Pass the immutable live object: the engine rejects stale menu actions
      // by identity and clones the inverse contract internally.
      if (!engine?.layers.commitLayerConversion(label, layer, converted)) {
        throw makeStatusError('not-ready');
      }
    },
    [base, defaultControlModel, engine, layer, makeStatusError]
  );

  const handleToggleVisibility = useCallback(() => {
    patchBase(t('widgets.layers.actions.toggleVisibility'), { isEnabled: !layer.isEnabled });
  }, [layer.isEnabled, patchBase, t]);

  const handleToggleHidden = useCallback(() => {
    commitPrepared(t('widgets.layers.actions.toggleHidden'), (model) =>
      model.prepare({ type: 'set-hidden', updates: [{ id: layer.id, isHidden: !isNodeHidden(layer) }] })
    );
  }, [commitPrepared, layer, t]);

  const handleToggleLock = useCallback(() => {
    patchBase(t('widgets.layers.actions.toggleLock'), { isLocked: !layer.isLocked });
  }, [layer.isLocked, patchBase, t]);

  const openRename = useCallback(() => setDialogKind('rename'), [setDialogKind]);
  const closeDialog = useCallback(() => setDialogKind(null), [setDialogKind]);
  const openRunWorkflow = useCallback(() => setDialogKind('run-workflow'), [setDialogKind]);
  const startSelectObject = useCallback(
    (layerId: string) => {
      if (!engine) {
        throw makeStatusError('not-ready');
      }
      const result = getCanvasOperations(engine).startSelectObject(layerId);
      if (result !== 'started') {
        throw makeStatusError(result);
      }
    },
    [engine, makeStatusError]
  );
  const startFilter = useCallback(
    (layerId: string) => {
      if (!engine) {
        throw makeStatusError('not-ready');
      }
      const result = getCanvasOperations(engine).startFilterOperation(layerId);
      if (result !== 'started') {
        throw makeStatusError(result);
      }
    },
    [engine, makeStatusError]
  );
  const submitRename = useCallback(
    (name: string) => {
      patchBase(t('widgets.layers.actions.rename'), { name });
    },
    [patchBase, t]
  );

  const handleTransform = useCallback(() => {
    dispatch({ id: layer.id, type: 'setCanvasSelectedLayer' });
    engine?.tools.setTool('transform');
  }, [dispatch, engine, layer.id]);

  const handleFitToBbox = useCallback(() => {
    const transform = fitLayerTransformToBbox(layer, bbox, documentRect);
    if (!transform) {
      throw makeStatusError('empty');
    }
    patchBase(getActionLabel('fit-to-bbox'), { transform });
  }, [bbox, documentRect, getActionLabel, layer, makeStatusError, patchBase]);

  const handleSaveToAssets = useCallback(async () => {
    if (!engine) {
      throw makeStatusError('not-ready');
    }

    const result = await saveLayerToAssets(layer.id, {
      exportLayer: engine.exports.exportBakedLayerBlob,
      upload: galleryTransfers.upload,
    });
    if (result !== 'saved' && result !== 'stale') {
      throw makeStatusError(result);
    }
  }, [engine, layer.id, makeStatusError]);

  const handleCopyToClipboard = useCallback(async () => {
    if (!engine) {
      throw makeStatusError('not-ready');
    }
    const result = await engine.exports.exportBakedLayerBlob(layer.id, { includeDisabled: true });
    if (result.status !== 'ok') {
      throw makeStatusError(result.status);
    }
    await copyBlobToClipboard(result.blob);
  }, [engine, layer.id, makeStatusError]);

  const handleCropToBbox = useCallback(async () => {
    if (!engine) {
      throw makeStatusError('not-ready');
    }
    const result = await engine.layers.cropLayerToBbox(layer.id);
    switch (result.status) {
      case 'cropped':
        notify.success(t('widgets.layers.actions.cropped'));
        return;
      case 'missing':
      case 'locked':
      case 'empty':
      case 'not-ready':
      case 'over-budget':
        throw makeStatusError(result.status);
      case 'busy':
        throw new Error(t('widgets.layers.actions.cropBusy'));
      case 'unsupported':
        throw new Error(t('widgets.layers.actions.cropUnsupported'));
      case 'failed':
        throw new Error(`${t('widgets.layers.actions.cropFailed')} ${result.message}`);
      default:
        return assertNever(result);
    }
  }, [engine, layer.id, makeStatusError, notify, t]);

  const handleExtractMaskedArea = useCallback(async () => {
    if (!engine) {
      throw makeStatusError('not-ready');
    }
    const result = await engine.exports.extractMaskedArea(layer.id);
    if (result.status !== 'extracted') {
      throw makeStatusError(result.status);
    }
  }, [engine, layer.id, makeStatusError]);

  const handleOpenProperties = useCallback(
    (section: LayerPropertiesSection) => {
      widgets.open({ region: 'right', widgetId: 'layers' });
      requestLayerProperties(layer.id, section);
    },
    [layer.id, widgets]
  );

  const handleBooleanRaster = useCallback(
    async (operation: BooleanRasterOperation) => {
      if (!engine) {
        throw makeStatusError('not-ready');
      }
      const result = await engine.layers.booleanMergeRasterLayers(layer.id, operation);
      if (result !== 'merged') {
        throw makeStatusError(result);
      }
    },
    [engine, layer.id, makeStatusError]
  );

  const handleCopyToRaster = useCallback(async () => {
    if (layer.type === 'control') {
      addCopy(copyControlToRaster(layer, createLayerId()), getActionLabel('copy-to-raster'));
      return;
    }
    if (!engine) {
      throw makeStatusError('not-ready');
    }
    if ((await engine.layers.copyLayerToRaster(layer.id)) === null) {
      throw new Error(t('widgets.layers.actions.copyFailed'));
    }
  }, [addCopy, engine, getActionLabel, layer, makeStatusError, t]);

  const handleCopyToControl = useCallback(() => {
    if (layer.type === 'raster') {
      addCopy(
        copyRasterToControl(layer, createLayerId(), base, defaultControlModel),
        getActionLabel('copy-to-control')
      );
    }
  }, [addCopy, base, defaultControlModel, getActionLabel, layer]);

  const handleCopyToInpaintMask = useCallback(() => {
    const id = createLayerId();
    const copied =
      layer.type === 'raster'
        ? copyRasterToInpaintMask(layer, id)
        : layer.type === 'control'
          ? copyControlToInpaintMask(layer, id)
          : layer.type === 'regional_guidance'
            ? copyRegionalGuidanceToInpaintMask(layer, id)
            : null;
    addCopy(copied, getActionLabel('copy-to-inpaint-mask'));
  }, [addCopy, getActionLabel, layer]);

  const handleCopyToRegionalGuidance = useCallback(() => {
    const id = createLayerId();
    const copied =
      layer.type === 'raster'
        ? copyRasterToRegionalGuidance(layer, id)
        : layer.type === 'control'
          ? copyControlToRegionalGuidance(layer, id)
          : layer.type === 'inpaint_mask'
            ? copyMaskToRegionalGuidance(layer, id)
            : null;
    addCopy(copied, getActionLabel('copy-to-regional-guidance'));
  }, [addCopy, getActionLabel, layer]);

  const handleCopyTo = useCallback(
    (target: LayerType): void | Promise<void> => {
      switch (target) {
        case 'raster':
          return handleCopyToRaster();
        case 'control':
          return handleCopyToControl();
        case 'inpaint_mask':
          return handleCopyToInpaintMask();
        case 'regional_guidance':
          return handleCopyToRegionalGuidance();
      }
    },
    [handleCopyToControl, handleCopyToInpaintMask, handleCopyToRaster, handleCopyToRegionalGuidance]
  );

  const handleLayerConfigAction = useCallback(
    (id: LayerConfigPatchKind) => {
      if (id === 'control-transparency-effect' && layer.type === 'control') {
        patchConfig(getActionLabel(id), getControlTransparencyEffectPatch(layer));
      } else if (id === 'regional-positive-prompt' && layer.type === 'regional_guidance') {
        patchConfig(getActionLabel(id), getRegionalGuidancePositivePromptPatch(layer));
      } else if (id === 'regional-negative-prompt' && layer.type === 'regional_guidance') {
        patchConfig(getActionLabel(id), getRegionalGuidanceNegativePromptPatch(layer));
      } else if (id === 'regional-reference-image' && layer.type === 'regional_guidance') {
        patchConfig(getActionLabel(id), getRegionalGuidanceReferenceImagePatch(layer, base));
      } else if (id === 'regional-auto-negative' && layer.type === 'regional_guidance') {
        patchConfig(getActionLabel(id), getRegionalGuidanceAutoNegativePatch(layer));
      } else if (id === 'inpaint-noise' && layer.type === 'inpaint_mask') {
        patchConfig(getActionLabel(id), getInpaintNoisePatch(layer));
      } else if (id === 'inpaint-denoise-limit' && layer.type === 'inpaint_mask') {
        patchConfig(getActionLabel(id), getInpaintDenoiseLimitPatch(layer));
      }
    },
    [base, getActionLabel, layer, patchConfig]
  );

  const effects = useMemo<LayerContextActionEffects>(
    () => ({
      booleanMerge: handleBooleanRaster,
      convertTo: (target) => {
        const actionId: LayerContextActionId =
          target === 'control'
            ? 'convert-to-control'
            : target === 'raster'
              ? 'convert-to-raster'
              : target === 'inpaint_mask'
                ? 'convert-to-inpaint-mask'
                : 'convert-to-regional-guidance';
        convert(target, getActionLabel(actionId));
      },
      copyTo: handleCopyTo,
      copyToClipboard: handleCopyToClipboard,
      cropToBbox: handleCropToBbox,
      delete: handleDelete,
      duplicate: handleDuplicate,
      extractMaskedArea: handleExtractMaskedArea,
      group: handleGroup,
      fitToBbox: handleFitToBbox,
      mergeDown: handleMerge,
      openProperties: handleOpenProperties,
      openRename,
      openRunWorkflow,
      startSelectObject,
      startFilter,
      patchConfig: handleLayerConfigAction,
      rasterize: handleRasterize,
      reorder: (kind, actionId) => reorder(kind, getActionLabel(actionId)),
      saveToAssets: handleSaveToAssets,
      toggleLock: handleToggleLock,
      toggleHidden: handleToggleHidden,
      toggleVisibility: handleToggleVisibility,
      transform: handleTransform,
    }),
    [
      convert,
      getActionLabel,
      handleBooleanRaster,
      handleCopyTo,
      handleCopyToClipboard,
      handleCropToBbox,
      handleDelete,
      handleDuplicate,
      handleExtractMaskedArea,
      handleFitToBbox,
      handleGroup,
      handleLayerConfigAction,
      handleMerge,
      handleOpenProperties,
      handleRasterize,
      handleSaveToAssets,
      handleToggleLock,
      handleToggleHidden,
      handleToggleVisibility,
      handleTransform,
      openRename,
      openRunWorkflow,
      startSelectObject,
      startFilter,
      reorder,
    ]
  );

  const runAction = useCallback(
    (action: LayerContextAction) => {
      void Promise.resolve()
        .then(() => action.handler({ ...actionState, effects }))
        .catch((error: unknown) => {
          notify.error(t('widgets.layers.actions.actionFailed'), toErrorMessage(error));
        });
    },
    [actionState, effects, notify, t]
  );
  const menuRenderEntries = getLayerContextMenuRenderEntries(menuLayout, Boolean(beforeDangerItems));
  const groupLayout = showGroupLabels ? getLayerContextMenuGroupLayout(menuLayout, Boolean(beforeDangerItems)) : null;

  return (
    <>
      <Menu.Root
        lazyMount={lazyMount}
        open={open}
        positioning={positioning}
        unmountOnExit={unmountOnExit}
        onOpenChange={onOpenChange}
      >
        {withTrigger ? (
          <Menu.Trigger asChild>
            <IconButton
              aria-label={t('widgets.layers.options')}
              color="fg.muted"
              size="2xs"
              variant="ghost"
              onClick={stopPropagation}
            >
              <MoreVerticalIcon />
            </IconButton>
          </Menu.Trigger>
        ) : null}
        <Portal>
          <Menu.Positioner>
            <MenuContent minW="14rem" py="1">
              {groupLayout ? (
                <>
                  <Menu.ItemGroup>
                    <Menu.ItemGroupLabel color="fg.subtle" fontSize="2xs" textTransform="uppercase">
                      {t(getLayerContextMenuLayerLabelKey(layer.type))}
                    </Menu.ItemGroupLabel>
                    {renderLayerMenuEntries({ entries: groupLayout.layerEntries, runAction, t })}
                  </Menu.ItemGroup>
                  {groupLayout.hasCanvasGroup ? (
                    <>
                      <Menu.Separator borderColor="border.subtle" />
                      <Menu.ItemGroup>
                        <Menu.ItemGroupLabel color="fg.subtle" fontSize="2xs" textTransform="uppercase">
                          {t('widgets.labels.canvas')}
                        </Menu.ItemGroupLabel>
                        {beforeDangerItems}
                      </Menu.ItemGroup>
                    </>
                  ) : null}
                  {renderLayerMenuEntries({ entries: groupLayout.trailingEntries, runAction, t })}
                </>
              ) : (
                renderLayerMenuEntries({
                  beforeDangerItems,
                  entries: menuRenderEntries,
                  runAction,
                  t,
                })
              )}
            </MenuContent>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
      <RenameDialog
        initialName={layer.name}
        isOpen={dialogKind === 'rename'}
        label={t('widgets.layers.actions.rename')}
        submitLabel={t('widgets.layers.actions.rename')}
        title={t('widgets.layers.actions.rename')}
        onClose={closeDialog}
        onSubmit={submitRename}
      />
      {dialogKind === 'run-workflow' ? (
        <RunLayerWorkflowDialog
          availability={workflowAvailability}
          engine={engine}
          isOpen
          layerId={layer.id}
          onClose={closeDialog}
        />
      ) : null}
    </>
  );
};

interface LayerRowMenuProps {
  dispatch: Dispatch<CanvasProjectMutation>;
  engine: LayerContextMenuEngine | null;
  layer: CanvasLayerContract;
}

/** The layers-panel per-row context menu: a ⋯ trigger button, opened below it. */
export const LayerContextMenu = (props: LayerRowMenuProps) => (
  <LayerMenu {...props} positioning={PANEL_POSITIONING} showGroupLabels withTrigger />
);

/** The layer + pointer position a canvas right-click resolved to. */
export interface CanvasLayerContextMenuTarget {
  layerId: string;
  x: number;
  y: number;
}

/**
 * The canvas-surface right-click menu: the SAME {@link LayerMenu}, anchored at the
 * cursor via a 1×1 virtual rect (no trigger DOM), controlled by `target`. The
 * canvas widget sets `target` to the hit layer + pointer position after selecting
 * it; `null` closes the menu. The layer is resolved from `target.layerId`
 * against the live document, so the shared items get the exact same inputs the
 * panel passes. Keyed by layer id so switching target resets the
 * menu's sibling-dialog state.
 *
 * Choosing a sibling-dialog action closes the menu, which nulls `target`. The
 * wrapper therefore owns the dialog-in-flight state and keeps rendering against
 * the last-known (sticky) target until the dialog closes (F1).
 */
export const CanvasLayerContextMenu = ({
  beforeDangerItems,
  dispatch,
  engine,
  target,
  showGroupLabels,
  onClose,
}: {
  beforeDangerItems?: ReactNode;
  dispatch: Dispatch<CanvasProjectMutation>;
  engine: LayerContextMenuEngine | null;
  target: CanvasLayerContextMenuTarget | null;
  showGroupLabels?: boolean;
  onClose: () => void;
}) => {
  // The layer a pending sibling dialog is anchored to. Captured while the live
  // target still exists, then retained until the dialog closes.
  const [dialogState, setDialogState] = useState<LayerMenuDialogState | null>(null);
  const renderTarget = resolveMenuTargetForRender(target, dialogState);

  const layerId = renderTarget?.layerId ?? null;
  const layer = useActiveProjectSelector((project) =>
    layerId ? (getDocumentLayer(project.canvas.document, layerId) ?? undefined) : undefined
  );

  const anchorX = renderTarget?.x ?? 0;
  const anchorY = renderTarget?.y ?? 0;
  const positioning = useMemo<MenuPositioning>(
    () => ({
      getAnchorRect: () => ({ height: 1, width: 1, x: anchorX, y: anchorY }),
      placement: 'bottom-start',
    }),
    [anchorX, anchorY]
  );
  const handleOpenChange = useCallback(
    (details: { open: boolean }) => {
      if (!details.open) {
        onClose();
      }
    },
    [onClose]
  );
  const handleDialogKindChange = useCallback(
    (kind: LayerMenuDialogKind | null) => {
      setDialogState(kind && target ? { kind, target } : null);
    },
    [target]
  );

  if (!renderTarget || !layer) {
    return null;
  }

  return (
    <LayerMenu
      key={renderTarget.layerId}
      beforeDangerItems={beforeDangerItems}
      dispatch={dispatch}
      dialogKind={dialogState?.kind ?? null}
      engine={engine}
      layer={layer}
      lazyMount
      // The menu itself is visible only while the live target is set; once a
      // sibling dialog closes it (target → null), the subtree stays mounted.
      open={!!target}
      positioning={positioning}
      showGroupLabels={showGroupLabels}
      unmountOnExit
      onOpenChange={handleOpenChange}
      onDialogKindChange={handleDialogKindChange}
    />
  );
};

const stopPropagation = (event: { stopPropagation: () => void }): void => event.stopPropagation();

const SUBMENU_META: Record<LayerContextSubmenuId, { defaultLabel: string; icon: LucideIcon; labelKey: string }> = {
  'add-modifiers': {
    defaultLabel: 'Add modifiers',
    icon: PlusIcon,
    labelKey: 'widgets.layers.menu.addModifiers',
  },
  'add-regional': { defaultLabel: 'Add', icon: PlusIcon, labelKey: 'widgets.layers.menu.add' },
  arrange: { defaultLabel: 'Arrange', icon: ArrowUpDownIcon, labelKey: 'widgets.layers.menu.arrange' },
  boolean: { defaultLabel: 'Boolean operations', icon: MergeIcon, labelKey: 'widgets.layers.menu.booleanOperations' },
  'convert-to': { defaultLabel: 'Convert to', icon: ArrowRightLeftIcon, labelKey: 'widgets.layers.menu.convertTo' },
  'copy-to': { defaultLabel: 'Copy to', icon: CopyIcon, labelKey: 'widgets.layers.menu.copyTo' },
};

const SUBMENU_POSITIONING = { placement: 'right-start' } as const;
const QUICK_MENU_TOOLTIP_CONTENT_PROPS = { fontSize: '2xs' } as const;
const QUICK_MENU_TOOLTIP_POSITIONING_PROPS = { placement: 'top' } as const;

const renderLayerMenuEntries = ({
  beforeDangerItems,
  entries,
  runAction,
  t,
}: {
  beforeDangerItems?: ReactNode;
  entries: readonly LayerContextMenuRenderEntry[];
  runAction: (action: LayerContextAction) => void;
  t: (key: string, options?: { defaultValue: string }) => string;
}) =>
  entries.map((entry) =>
    entry.kind === 'slot' ? (
      <Fragment key={entry.id}>
        <Menu.Separator borderColor="border.subtle" />
        {beforeDangerItems}
      </Fragment>
    ) : (
      <LayerMenuSection key={entry.section.id} runAction={runAction} section={entry.section} t={t} />
    )
  );

const LayerMenuSection = ({
  runAction,
  section,
  t,
}: {
  runAction: (action: LayerContextAction) => void;
  section: LayerContextMenuSection;
  t: (key: string, options: { defaultValue: string }) => string;
}) => {
  const content = section.items.map((item) => (
    <LayerMenuLayoutItem
      key={item.kind === 'action' ? item.action.id : item.id}
      compact={section.presentation === 'row'}
      item={item}
      runAction={runAction}
      t={t}
    />
  ));

  if (section.presentation === 'row') {
    return <HStack gap="1">{content}</HStack>;
  }

  return (
    <>
      <Menu.Separator borderColor="border.subtle" />
      {content}
    </>
  );
};

const LayerMenuLayoutItem = ({
  compact,
  item,
  runAction,
  t,
}: {
  compact: boolean;
  item: LayerContextMenuItem;
  runAction: (action: LayerContextAction) => void;
  t: (key: string, options: { defaultValue: string }) => string;
}) => {
  if (item.kind === 'action') {
    return compact ? (
      <LayerMenuIconActionItem action={item.action} runAction={runAction} t={t} />
    ) : (
      <LayerMenuActionItem action={item.action} runAction={runAction} t={t} />
    );
  }

  return <LayerMenuSubmenu compact={compact} item={item} runAction={runAction} t={t} />;
};

const LayerMenuSubmenu = ({
  compact,
  item,
  runAction,
  t,
}: {
  compact: boolean;
  item: Extract<LayerContextMenuItem, { kind: 'submenu' }>;
  runAction: (action: LayerContextAction) => void;
  t: (key: string, options: { defaultValue: string }) => string;
}) => {
  const meta = SUBMENU_META[item.id];
  const label = t(meta.labelKey, { defaultValue: meta.defaultLabel });

  return (
    <Menu.Root positioning={SUBMENU_POSITIONING}>
      <Menu.TriggerItem
        aria-label={label}
        flex={compact ? '1' : undefined}
        justifyContent={compact ? 'center' : undefined}
      >
        {compact ? (
          <Tooltip
            showArrow
            content={label}
            contentProps={QUICK_MENU_TOOLTIP_CONTENT_PROPS}
            openDelay={300}
            positioning={QUICK_MENU_TOOLTIP_POSITIONING_PROPS}
          >
            <Icon as={meta.icon} boxSize="4" color="fg" />
          </Tooltip>
        ) : (
          <HStack gap="2" minW="0" w="full">
            <Icon as={meta.icon} boxSize="3.5" color="fg.subtle" flexShrink={0} />
            <Text flex="1" fontSize="xs">
              {label}
            </Text>
            <Icon as={ChevronRightIcon} boxSize="3" color="fg.subtle" flexShrink={0} />
          </HStack>
        )}
      </Menu.TriggerItem>
      <Portal>
        <Menu.Positioner>
          <MenuContent minW="13rem" py="1">
            {item.actions.map((action) => (
              <LayerMenuActionItem key={action.id} action={action} runAction={runAction} t={t} />
            ))}
          </MenuContent>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
};

const LayerMenuIconActionItem = ({
  action,
  runAction,
  t,
}: {
  action: LayerContextAction;
  runAction: (action: LayerContextAction) => void;
  t: (key: string, options: { defaultValue: string }) => string;
}) => {
  const onSelect = useCallback(() => runAction(action), [action, runAction]);

  return (
    <LayerMenuIconItem
      disabled={action.isDisabled}
      icon={action.icon}
      label={t(action.labelKey, { defaultValue: action.defaultLabel })}
      value={action.id}
      onSelect={onSelect}
    />
  );
};

const LayerMenuActionItem = ({
  action,
  runAction,
  t,
}: {
  action: LayerContextAction;
  runAction: (action: LayerContextAction) => void;
  t: (key: string, options: { defaultValue: string }) => string;
}) => {
  const onSelect = useCallback(() => runAction(action), [action, runAction]);

  return (
    <LayerMenuItem
      color={action.tone === 'danger' ? 'fg.error' : undefined}
      disabled={action.isDisabled}
      icon={action.icon}
      label={t(action.labelKey, { defaultValue: action.defaultLabel })}
      value={action.id}
      onSelect={onSelect}
    />
  );
};

const LayerMenuItem = ({
  color,
  disabled,
  icon,
  label,
  onSelect,
  value,
}: {
  color?: string;
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  value: string;
}) => (
  <Menu.Item color={color} disabled={disabled} value={value} onSelect={onSelect}>
    <HStack gap="2" minW="0" w="full">
      <Icon as={icon} boxSize="3.5" color={color ?? 'fg.subtle'} flexShrink={0} />
      <Text flex="1" fontSize="xs">
        {label}
      </Text>
    </HStack>
  </Menu.Item>
);

const LayerMenuIconItem = ({
  color,
  disabled,
  icon,
  label,
  onSelect,
  value,
}: {
  color?: string;
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  value: string;
}) => (
  <Tooltip
    showArrow
    content={label}
    contentProps={QUICK_MENU_TOOLTIP_CONTENT_PROPS}
    openDelay={300}
    positioning={QUICK_MENU_TOOLTIP_POSITIONING_PROPS}
  >
    <Menu.Item
      aria-label={label}
      color={color}
      disabled={disabled}
      flex="1"
      justifyContent="center"
      value={value}
      onSelect={onSelect}
    >
      <Icon as={icon} boxSize="4" color={color ?? 'fg'} />
    </Menu.Item>
  </Tooltip>
);
