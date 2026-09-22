import { classifyGalleryUpload } from '@features/gallery/contracts';
import { useMountEffect } from '@platform/react/useMountEffect';
import { isEditableHotkeyTarget } from '@workbench/hotkeys/keys';
import { isHotkeyModalLayerActive } from '@workbench/hotkeys/modalLayer';
import { lazy, Suspense, useCallback, useState } from 'react';

export interface PasteMediaRequest {
  ticket: number;
  files: File[];
  returnFocus: HTMLElement | null;
  settle: () => void;
}

// Not every dialog registers a hotkey modal layer (ConfirmDialog, RenameDialog,
// feature-owned dialogs); a paste from inside any open dialog stays with it.
const isInsideDialog = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"]') !== null;

const PasteMediaDialog = lazy(() =>
  import('./PasteMediaDialog').then((module) => ({ default: module.PasteMediaDialog }))
);

/**
 * Turns a media paste anywhere in the workbench into a destination choice.
 * The canvas keeps its own `mod+v` (a layer from the clipboard pixels): its
 * hotkey cancels the keydown, so no paste event reaches here while the canvas
 * owns focus. Text pasted into a field and pastes inside open dialogs are never
 * intercepted.
 */
export const PasteMediaRuntime = () => {
  const [request, setRequest] = useState<PasteMediaRequest | null>(null);
  const settle = useCallback(() => setRequest(null), []);

  useMountEffect(() => {
    let ticket = 0;
    const handlePaste = (event: ClipboardEvent) => {
      const clipboard = event.clipboardData;
      if (!clipboard || isHotkeyModalLayerActive() || isInsideDialog(event.target)) {
        return;
      }
      if (isEditableHotkeyTarget(event.target) && clipboard.types.includes('text/plain')) {
        return;
      }
      const files = Array.from(clipboard.files).filter((file) => classifyGalleryUpload(file) !== null);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      setRequest({
        ticket: ++ticket,
        files,
        returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
        settle,
      });
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  });

  return request ? (
    <Suspense fallback={null}>
      <PasteMediaDialog key={request.ticket} request={request} />
    </Suspense>
  ) : null;
};
