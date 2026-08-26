import type { CanvasLoadRefusal } from './canvasLoadContracts';
import type { RefusedWorkbenchProject } from './projectContracts';

import { isRecord, loadCanvasState } from './canvasMigration';

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The project-ingestion gate: version-checks every canvas embedded in a raw project document
 * before anything migrates, defaults, or clones it. A live canvas is refused for any load
 * failure; a queue-history canvas is refused only when a newer client wrote it, since an invalid
 * history record is recoverable without rewriting the project (see `normalizeWorkbenchQueueHistory`).
 */
export const gateProjectCanvases = (raw: unknown): RefusedWorkbenchProject | null => {
  if (!isRecord(raw)) {
    return null;
  }
  const refuse = (
    refusal: CanvasLoadRefusal,
    source: RefusedWorkbenchProject['source'],
    queueItem?: RefusedWorkbenchProject['queueItem']
  ): RefusedWorkbenchProject => ({
    projectId: asString(raw.id),
    projectName: asString(raw.name),
    raw,
    refusal,
    source,
    ...(queueItem ? { queueItem } : {}),
  });

  const canvas = loadCanvasState(raw.canvas);
  if (canvas.status !== 'loaded') {
    return refuse(canvas, 'canvas');
  }

  const items = isRecord(raw.queue) && Array.isArray(raw.queue.items) ? raw.queue.items : [];
  for (const [index, item] of items.entries()) {
    const snapshot = isRecord(item) && isRecord(item.snapshot) ? item.snapshot : null;
    if (!snapshot || !isRecord(snapshot.canvas)) {
      continue;
    }
    const result = loadCanvasState(snapshot.canvas);
    if (result.status === 'unsupported-version') {
      return refuse(result, 'queue-item', {
        index,
        itemId: isRecord(item) && typeof item.id === 'string' ? item.id : null,
      });
    }
  }
  return null;
};
