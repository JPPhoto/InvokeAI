import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  initializeQueuePerformanceInstrumentation,
  QUEUE_PERFORMANCE_STORAGE_KEY,
  startQueuePerformanceMeasure,
} from './queuePerformance';

const createStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    removeItem: vi.fn((key: string) => values.delete(key)),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  };
};

describe('queue performance instrumentation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('persists enablement across reloads and exposes the controller on window', () => {
    const localStorage = createStorage();
    vi.stubGlobal('window', { localStorage });

    const controller = initializeQueuePerformanceInstrumentation();
    controller.enable();

    expect(localStorage.setItem).toHaveBeenCalledWith(QUEUE_PERFORMANCE_STORAGE_KEY, '1');
    expect(window.__invokeQueuePerf).toBe(controller);
    expect(controller.enabled).toBe(true);

    controller.disable();
    expect(localStorage.removeItem).toHaveBeenCalledWith(QUEUE_PERFORMANCE_STORAGE_KEY);
    expect(controller.enabled).toBe(false);
  });

  it('records named phases only while enabled', () => {
    const localStorage = createStorage();
    vi.stubGlobal('window', { localStorage });
    const controller = initializeQueuePerformanceInstrumentation();

    startQueuePerformanceMeasure('api', 'POST api/v1/queue/default/items_by_ids')({ itemCount: 3 });
    expect(controller.entries).toEqual([]);

    controller.enable();
    const finish = startQueuePerformanceMeasure('cache', 'items_by_ids cache upsert', { itemCount: 3 });
    finish({ responseMiB: 8.2 });
    finish({ responseMiB: 99 });

    expect(controller.entries).toHaveLength(1);
    expect(controller.entries[0]).toMatchObject({
      phase: 'cache',
      name: 'items_by_ids cache upsert',
      itemCount: 3,
      responseMiB: 8.2,
    });

    controller.clear();
    expect(controller.entries).toEqual([]);
    controller.disable();
  });
});
