import type { ToolId } from '@workbench/canvas-engine/api';
import type { CanvasOperationState } from '@workbench/canvas-operations/api';
import type { CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';
import type { ComponentType } from 'react';

import type { ToolbarRegionId, ToolbarRegionPlacement } from './toolbarLayout';

export type CanvasToolOptionsEngine = Pick<
  CanvasEngineHandle,
  'document' | 'interaction' | 'layers' | 'projectId' | 'selection' | 'tools' | 'viewport'
>;

export type CanvasOperationKind = Extract<CanvasOperationState, { status: 'active' }>['identity']['kind'];

export interface ToolbarRegionProps {
  engine: CanvasToolOptionsEngine;
  /** Staging or generation owns the surface: mutating controls disable, Cancel stays. */
  isSurfaceInteractionLocked: boolean;
  /** Inside the bar, or stacked inside the More menu when the bar is too narrow. */
  placement: ToolbarRegionPlacement;
}

export interface ToolbarStatusProps {
  compact: boolean;
  engine: CanvasToolOptionsEngine;
  isExternalInteractionLocked: boolean;
}

export type ToolbarRegionComponent = ComponentType<ToolbarRegionProps>;

/** The flexible modes region declares the bar width its content needs; the layout demotes it when that does not fit. */
export interface ToolbarModesRegion {
  component: ToolbarRegionComponent;
  width: number;
}

/**
 * One tool's presentation in the context toolbar: which region each of its
 * primary controls renders in, what only the More menu shows, and which region
 * stays in the bar at every width. The adapter is a presentation seam over the
 * engine's option stores and document transactions; it owns no state.
 */
export interface ToolPresentationAdapter {
  id: ToolId;
  icon: ComponentType;
  primary: ToolbarRegionId | null;
  /** Paints into one leaf: a selected group gets the "select a layer" notice instead of strokes. */
  paintsLeaf?: boolean;
  geometry?: ToolbarRegionComponent;
  intensity?: ToolbarRegionComponent;
  color?: ToolbarRegionComponent;
  modes?: ToolbarModesRegion;
  more?: ToolbarRegionComponent;
  status?: ComponentType<ToolbarStatusProps>;
}

/** A guarded operation takes over the modes, More and status slots while it is active; the tool's own regions stay. */
export interface OperationPresentationAdapter {
  kind: CanvasOperationKind;
  modes?: ToolbarModesRegion;
  more?: ToolbarRegionComponent;
  status: ComponentType<ToolbarStatusProps>;
}
