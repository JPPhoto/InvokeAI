import type { CanvasDocumentContractV3 } from '@workbench/canvas-engine/api';
import type { CanvasProjectMutation } from '@workbench/canvasProjectMutations';
import type { CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';
import type { Dispatch } from 'react';

import { getDocumentNode } from '@workbench/canvas-engine/api';
import { useCallback, useMemo } from 'react';

import type { LayerSurfaceAnchor } from './layerRowCommands';

import { CanvasLayerContextMenu, type LayerContextMenuEngine } from './LayerContextMenu';
import { LayerGroupContextMenu, type LayerGroupContextMenuEngine } from './LayerGroupContextMenu';
import { LayerPropertiesPopover, type LayerPropertiesEngine } from './LayerPropertiesPopover';

export type LayerSurfaceEngine = LayerContextMenuEngine &
  LayerGroupContextMenuEngine &
  LayerPropertiesEngine &
  Pick<CanvasEngineHandle, 'projectId'>;

/** What the panel currently shows beside a row, addressed by node id rather than owned by the row. */
export interface LayerSurfaceRequest {
  readonly kind: 'menu' | 'properties';
  readonly id: string;
  readonly anchor: LayerSurfaceAnchor;
}

interface LayerSurfaceHostProps {
  dispatch: Dispatch<CanvasProjectMutation>;
  document: CanvasDocumentContractV3;
  editingLocked: boolean;
  engine: LayerSurfaceEngine | null;
  surface: LayerSurfaceRequest | null;
  onClose: () => void;
}

/**
 * The one menu and one properties popover the whole panel shares. A row asks for a surface by id
 * and anchor; nothing heavier than a button lives in the row. A surface whose node has gone
 * closes itself.
 */
export const LayerSurfaceHost = ({
  dispatch,
  document,
  editingLocked,
  engine,
  surface,
  onClose,
}: LayerSurfaceHostProps) => {
  const node = surface ? getDocumentNode(document, surface.id) : null;
  const menuTarget = useMemo(
    () =>
      surface?.kind === 'menu' && node && node.type !== 'group'
        ? { layerId: node.id, x: surface.anchor.x, y: surface.anchor.y + surface.anchor.height }
        : null,
    [node, surface]
  );
  const handleMenuClose = useCallback(() => onClose(), [onClose]);
  if (surface && !node) {
    return null;
  }
  return (
    <>
      <CanvasLayerContextMenu dispatch={dispatch} engine={engine} target={menuTarget} onClose={handleMenuClose} />
      {surface?.kind === 'menu' && node?.type === 'group' && engine ? (
        <LayerGroupContextMenu
          key={node.id}
          anchor={surface.anchor}
          editingLocked={editingLocked}
          engine={engine}
          group={node}
          stack={engine.document.model()?.getEntry(node.id)?.stack ?? 'raster'}
          onClose={onClose}
        />
      ) : null}
      {surface?.kind === 'properties' && node && node.type !== 'group' && !editingLocked ? (
        <LayerPropertiesPopover key={node.id} anchor={surface.anchor} engine={engine} layer={node} onClose={onClose} />
      ) : null}
    </>
  );
};
