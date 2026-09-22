import type { GalleryItem } from '@features/gallery';
import type { ImageActions } from '@workbench/image-actions';

import { registerAccountOwnedResource } from '@platform/state/accountLifecycle';
import { createExternalStore } from '@platform/state/externalStore';

/** The loupe's commands, published once per selection; the readout lives in `previewStageStore`. */
export interface PreviewZoomCommands {
  reset: () => void;
  /** Zoom to a fraction of the image's own pixels (1 = 100%), never below fit. */
  zoomTo: (actualZoom: number) => void;
}

/** What the header's zoom menu renders: the readout plus the commands. */
export type PreviewZoomControls = PreviewZoomCommands & PreviewZoomReadout;

/** What the loupe shows, as percents of the image's own pixels. */
export interface PreviewZoomReadout {
  /** What the fitted image shows, for the menu's presets. */
  fitPercent: number | null;
  isZoomed: boolean;
  /** What is on screen right now. */
  percent: number | null;
}

/** Where the selection sits in its board, for the Details popover's header line. */
export interface PreviewItemPosition {
  boardItemCount: number;
  isLoadingBoard: boolean;
  selectedIndex: number;
}

/**
 * Header context published by the preview view so the widget frame's chrome
 * (label + header actions) can render the current selection without refetching
 * boards or re-instantiating image actions. The preview is a singleton widget
 * (`allowMultiple: false`), so one module-level store is safe. Cleared when
 * the view unmounts or nothing is selected; the chrome falls back to the
 * static title and hides the action strip.
 */
export interface PreviewHeaderContext {
  /** The selected item with board/star context, ready for common actions. */
  actionItem: GalleryItem | null;
  /** The view's `useImageActions` instance (carries delete-neighbor handling). */
  actions: ImageActions | null;
  boardName: string | null;
  copyCurrentVideoFrame: (() => void) | null;
  isVideoFrameCopyAvailable: boolean;
  itemName: string | null;
  /**
   * Opens the view's full image context menu anchored at viewport coordinates.
   * The header's "image actions" dropdown reuses the exact right-click menu —
   * one source of truth for every image verb.
   */
  openItemMenu: ((x: number, y: number) => void) | null;
  position: PreviewItemPosition | null;
  /** Null unless the selection is an image the loupe can zoom. */
  zoom: PreviewZoomCommands | null;
}

const emptyContext: PreviewHeaderContext = {
  actionItem: null,
  actions: null,
  boardName: null,
  copyCurrentVideoFrame: null,
  isVideoFrameCopyAvailable: false,
  itemName: null,
  openItemMenu: null,
  position: null,
  zoom: null,
};

const store = createExternalStore<PreviewHeaderContext>(emptyContext);

export const previewHeaderStore = {
  clear(): void {
    store.patchSnapshot(emptyContext);
  },
  set(context: PreviewHeaderContext): void {
    store.patchSnapshot(context);
  },
};

registerAccountOwnedResource({
  clear: previewHeaderStore.clear,
  name: 'preview-header',
});

export const usePreviewHeaderContext = (): PreviewHeaderContext => store.useSelector((snapshot) => snapshot);

/**
 * The view's hot-path readouts, written straight from ref callbacks and the
 * loupe so a wheel tick re-renders the header's zoom menu and nothing else —
 * never the view, its filmstrip, or the context menu.
 */
export interface PreviewStageContext {
  /** The media stage; the Details popover keeps within it, off the filmstrip. */
  stageElement: HTMLElement | null;
  zoom: PreviewZoomReadout | null;
}

const emptyStage: PreviewStageContext = { stageElement: null, zoom: null };
const stageStore = createExternalStore<PreviewStageContext>(emptyStage);

export const previewStageStore = {
  clear(): void {
    stageStore.patchSnapshot(emptyStage);
  },
  setStageElement(stageElement: HTMLElement | null): void {
    stageStore.patchSnapshot({ stageElement });
  },
  setZoom(zoom: PreviewZoomReadout | null): void {
    stageStore.patchSnapshot({ zoom });
  },
};

registerAccountOwnedResource({
  clear: previewStageStore.clear,
  name: 'preview-stage',
});

export const usePreviewStageContext = (): PreviewStageContext => stageStore.useSelector((snapshot) => snapshot);
