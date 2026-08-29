import type { ToolId } from '@workbench/canvas-engine/api';
import type { CanvasOperationState } from '@workbench/canvas-operations/api';
import type { CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';
import type { ComponentType } from 'react';

export type CanvasToolOptionsEngine = Pick<
  CanvasEngineHandle,
  'document' | 'interaction' | 'layers' | 'projectId' | 'selection' | 'tools' | 'viewport'
>;

export type CanvasOperationKind = Extract<CanvasOperationState, { status: 'active' }>['identity']['kind'];

export type ToolbarRegionId = 'geometry' | 'intensity' | 'color' | 'modes';

export interface ToolbarRegionProps {
  engine: CanvasToolOptionsEngine;
  /** Staging or generation owns the surface: mutating controls disable, Cancel stays. */
  isSurfaceInteractionLocked: boolean;
}

export interface ToolbarStatusProps {
  engine: CanvasToolOptionsEngine;
  isExternalInteractionLocked: boolean;
}

export type ToolbarRegionComponent = ComponentType<ToolbarRegionProps>;

/**
 * One tool's presentation: a component per region of its settings (geometry,
 * intensity, color, modes, and what only the full form shows), rendered by the
 * Properties widget. The adapter is a presentation seam over the engine's
 * option stores and document transactions; it owns no state.
 */
export interface ToolPresentationAdapter {
  id: ToolId;
  /** Paints into one leaf: a selected group gets the "select a layer" notice instead of strokes. */
  paintsLeaf?: boolean;
  /** Translation keys naming the rows where the generic region name would mislead (brush "Size", not "Geometry"). */
  rowLabels?: Partial<Record<ToolbarRegionId | 'more', string>>;
  geometry?: ToolbarRegionComponent;
  intensity?: ToolbarRegionComponent;
  color?: ToolbarRegionComponent;
  modes?: ToolbarRegionComponent;
  more?: ToolbarRegionComponent;
  status?: ComponentType<ToolbarStatusProps>;
}

/** A guarded operation's presentation: its inputs, its secondary controls and its status with Apply / Cancel. */
export interface OperationPresentationAdapter {
  kind: CanvasOperationKind;
  modes?: ToolbarRegionComponent;
  more?: ToolbarRegionComponent;
  status: ComponentType<ToolbarStatusProps>;
}
