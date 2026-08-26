import { describe, expect, it } from 'vitest';

import { createEmptyCanvasStateV2 } from './canvasMigration';
import { gateProjectCanvases } from './projectCanvasGate';

const canvas = createEmptyCanvasStateV2();
const queueItem = (id: string, itemCanvas: unknown) => ({ id, snapshot: { canvas: itemCanvas } });

describe('gateProjectCanvases', () => {
  it('admits a project whose live and queued canvases load', () => {
    expect(gateProjectCanvases({ canvas, id: 'p', name: 'P', queue: { items: [queueItem('q', canvas)] } })).toBeNull();
    expect(gateProjectCanvases({ id: 'legacy', name: 'Legacy' })).toBeNull();
    expect(gateProjectCanvases('not a project')).toBeNull();
  });

  it('refuses a project whose live canvas is unsupported or invalid, keeping the raw document', () => {
    const future = { canvas: { ...canvas, version: 3 }, id: 'p', name: 'P' };
    const broken = { canvas: { ...canvas, version: '2' }, id: 'p', name: 'P' };

    expect(gateProjectCanvases(future)).toMatchObject({
      projectId: 'p',
      projectName: 'P',
      raw: future,
      refusal: { scope: 'state', status: 'unsupported-version', version: 3 },
      source: 'canvas',
    });
    expect(gateProjectCanvases(broken)).toMatchObject({
      raw: broken,
      refusal: { status: 'invalid' },
      source: 'canvas',
    });
  });

  it('refuses a project only for a future-version queue canvas, naming the item', () => {
    const invalidItem = queueItem('invalid', { ...canvas, version: '2' });
    const futureItem = queueItem('future', { ...canvas, version: 3 });

    expect(gateProjectCanvases({ canvas, id: 'p', name: 'P', queue: { items: [invalidItem] } })).toBeNull();
    expect(
      gateProjectCanvases({ canvas, id: 'p', name: 'P', queue: { items: [invalidItem, futureItem] } })
    ).toMatchObject({
      queueItem: { index: 1, itemId: 'future' },
      refusal: { status: 'unsupported-version', version: 3 },
      source: 'queue-item',
    });
  });
});
