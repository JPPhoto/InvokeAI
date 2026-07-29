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

  it('bounds recent entries while retaining aggregate and slowest diagnostics', () => {
    const localStorage = createStorage();
    vi.stubGlobal('window', { localStorage });
    let currentTime = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => currentTime);
    vi.spyOn(console, 'table').mockImplementation(() => undefined);
    const controller = initializeQueuePerformanceInstrumentation();
    controller.enable();

    for (let index = 0; index < 300; index++) {
      currentTime = index * 2;
      const finish = startQueuePerformanceMeasure('api', 'GET api/v1/queue/default/status');
      currentTime += 1;
      finish();
    }
    expect(controller.entries).toHaveLength(250);

    currentTime = 10 * 60 * 1_000 + 1_000;
    const finish = startQueuePerformanceMeasure('api', 'GET api/v1/queue/default/current');
    currentTime += 20;
    finish();

    const report = controller.report();
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.name).toBe('GET api/v1/queue/default/current');
    expect(report.slowestEntries).toHaveLength(25);
    expect(report.aggregates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'GET api/v1/queue/default/status',
          count: 300,
          averageDurationMs: 1,
          maxDurationMs: 1,
        }),
        expect.objectContaining({
          name: 'GET api/v1/queue/default/current',
          count: 1,
          averageDurationMs: 20,
          maxDurationMs: 20,
        }),
      ])
    );

    controller.clear();
    const clearedReport = controller.report();
    expect(clearedReport).toMatchObject({
      aggregates: [],
      entries: [],
      slowestEntries: [],
    });
    controller.disable();
  });

  it('caps raw API resources and aggregates repeated resource routes', () => {
    const localStorage = createStorage();
    vi.stubGlobal('window', { localStorage });
    vi.spyOn(console, 'table').mockImplementation(() => undefined);
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue(
      Array.from(
        { length: 300 },
        (_, index) =>
          ({
            duration: 100 + index,
            entryType: 'resource',
            name: `http://test/api/v1/images/i/image-${index}.png/thumbnail?media_cookie_version=1`,
            requestStart: index + 10,
            responseEnd: index + 100,
            responseStart: index + 90,
            startTime: index,
            transferSize: 1_024,
          }) as PerformanceResourceTiming
      )
    );
    const controller = initializeQueuePerformanceInstrumentation();
    controller.enable();

    const report = controller.report();

    expect(report.resources).toHaveLength(250);
    expect(report.resourceAggregates).toEqual([
      expect.objectContaining({
        name: '/api/v1/images/i/:id/thumbnail?media_cookie_version',
        count: 300,
        averageQueueDelayMs: 10,
        averageServerWaitMs: 80,
      }),
    ]);
    controller.disable();
  });
});
