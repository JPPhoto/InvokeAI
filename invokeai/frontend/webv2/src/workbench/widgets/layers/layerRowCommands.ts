import type { LayerSelectionModifiers } from '@workbench/layerPanelState';
import type { KeyboardEvent } from 'react';

/** A point or box the surface host anchors a menu or popover to, in viewport pixels. */
export interface LayerSurfaceAnchor {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Everything a row can ask for. One stable object per tree, so a row re-renders only when its
 * own view model or selection facts change; the tree owns every store subscription and commit.
 */
export interface LayerRowCommands {
  select(id: string, modifiers: LayerSelectionModifiers): void;
  focus(id: string): void;
  toggleExpanded(id: string): void;
  setEnabled(id: string, isEnabled: boolean): void;
  setHidden(id: string, isHidden: boolean): void;
  setLocked(id: string, isLocked: boolean): void;
  startRename(id: string): void;
  rename(id: string, name: string): void;
  endRename(): void;
  openMenu(id: string, anchor: LayerSurfaceAnchor): void;
  openProperties(id: string, anchor: LayerSurfaceAnchor): void;
  keyDown(id: string, event: KeyboardEvent<HTMLElement>): void;
}

export const anchorFromRect = (rect: DOMRect): LayerSurfaceAnchor => ({
  height: rect.height,
  width: rect.width,
  x: rect.left,
  y: rect.top,
});

export const anchorFromPoint = (x: number, y: number): LayerSurfaceAnchor => ({ height: 1, width: 1, x, y });
