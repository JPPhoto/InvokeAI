import type { CanvasDocumentContractV3 } from '@workbench/canvas-engine/api';
import type { CanvasPreparedEngine, PreparedCommitOutcome } from '@workbench/widgets/canvas/useStructuralCommit';

import { getDocumentIndex, isGroupNode } from '@workbench/canvas-engine/api';
import { publishLayerPanelSelection, readLayerPanelState, setLayerGroupExpanded } from '@workbench/layerPanelState';
import { commitPreparedEdit } from '@workbench/widgets/canvas/useStructuralCommit';

import { createLayerId, nextGroupName } from './layerOps';

/** Whether `ids` name siblings the model can wrap in one group. */
export const canGroupNodes = (document: CanvasDocumentContractV3, ids: readonly string[]): boolean => {
  const index = getDocumentIndex(document);
  const entries = ids.map((id) => index.byId.get(id)).filter((entry) => entry !== undefined);
  if (entries.length === 0 || entries.length !== ids.length) {
    return false;
  }
  const selected = new Set(ids);
  const outer = entries.filter((entry) => !entry.path.some((ancestor) => selected.has(ancestor)));
  const first = outer[0]!;
  return outer.every((entry) => entry.stack === first.stack && entry.parentId === first.parentId);
};

/** Whether any of `ids` is a group the model can dissolve. */
export const canUngroupNodes = (document: CanvasDocumentContractV3, ids: readonly string[]): boolean =>
  ids.some((id) => {
    const node = getDocumentIndex(document).byId.get(id)?.node;
    return !!node && isGroupNode(node);
  });

/**
 * Wraps `ids` in a new group, selects it, and shows its children. The selection is published only
 * for an edit the model accepted, before the commit so reconciliation keeps it, and rolled back if
 * the commit does not land.
 */
export const groupLayers = (
  engine: CanvasPreparedEngine | null,
  projectId: string,
  ids: readonly string[],
  label: string
): PreparedCommitOutcome => {
  const model = engine?.document.model() ?? null;
  if (!engine || !model) {
    return { status: 'not-ready' };
  }
  const groupId = createLayerId();
  const names = getDocumentIndex(model.document).nodes.map((entry) => entry.node.name);
  const result = model.prepare({ groupId, ids, name: nextGroupName(names), type: 'group' });
  if (result.status === 'unchanged') {
    return result;
  }
  if (result.status !== 'prepared') {
    return { refusal: result, status: 'refused' };
  }
  const previous = readLayerPanelState(projectId, model.document.selectedLayerId);
  setLayerGroupExpanded(projectId, model.document.selectedLayerId, [groupId], true);
  publishLayerPanelSelection({ primaryId: groupId, projectId, selectedIds: [groupId] });
  const outcome = engine.layers.commitPrepared(label, result.edit);
  if (outcome.status !== 'committed') {
    publishLayerPanelSelection({
      anchorId: previous.anchorId,
      primaryId: previous.primaryId,
      projectId,
      selectedIds: previous.selectedIds,
    });
    setLayerGroupExpanded(projectId, previous.primaryId, [groupId], false);
  }
  return outcome;
};

/** Dissolves every group among `ids`; nothing to dissolve is a quiet no-op. */
export const ungroupLayers = (
  engine: CanvasPreparedEngine | null,
  ids: readonly string[],
  label: string
): PreparedCommitOutcome =>
  commitPreparedEdit(engine, label, (model) => {
    const groupIds = ids.filter((id) => {
      const node = model.getNode(id);
      return !!node && isGroupNode(node);
    });
    return groupIds.length === 0 ? { status: 'unchanged' } : model.prepare({ ids: groupIds, type: 'ungroup' });
  });
