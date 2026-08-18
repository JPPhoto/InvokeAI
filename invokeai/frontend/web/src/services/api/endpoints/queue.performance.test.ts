/* eslint-disable no-console */
import { configureStore } from '@reduxjs/toolkit';
import { api } from 'services/api';
import { initializeQueuePerformanceInstrumentation } from 'services/api/queuePerformance';
import type { GetQueueItemSummariesByItemIdsResult } from 'services/api/types';
import stableHash from 'stable-hash';
import type { Param0 } from 'tsafe';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { queueApi } from './queue';

const RUN_PERFORMANCE_TESTS = process.env.INVOKEAI_PERFORMANCE_TESTS === '1';
const TARGET_LARGE_RESPONSE_BYTES = 8 * 1024 * 1024;
const LARGE_HISTORY_COUNT = 20_000;

const buildQueueItemSummary = (itemId: number, valueSize: number) => ({
  item_id: itemId,
  status: 'completed',
  batch_id: `batch-${itemId}`,
  origin: 'workflows',
  destination: 'workflows',
  created_at: '2026-01-01T00:00:00Z',
  started_at: '2026-01-01T00:00:00Z',
  completed_at: '2026-01-01T00:00:01Z',
  user_id: 'system',
  user_display_name: null,
  user_email: null,
  field_values: [{ node_path: 'source', field_name: 'value', value: 'x'.repeat(valueSize) }],
});

const createApiStore = () =>
  configureStore({
    reducer: { [api.reducerPath]: api.reducer },
    // Match the production app store. Development-only recursive state checks would measure
    // tooling overhead rather than the user's production queue path.
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ immutableCheck: false, serializableCheck: false }).concat(api.middleware),
  });

const inputUrl = (input: Request | URL | string): string => (input instanceof Request ? input.url : String(input));

describe.skipIf(!RUN_PERFORMANCE_TESTS)('queue large-payload performance', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('measures fetch decoding and RTK Query hydration for an 8 MiB summary response', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://test' } });
    vi.stubGlobal('localStorage', { getItem: () => null });
    const instrumentation = initializeQueuePerformanceInstrumentation();
    instrumentation.enable();
    instrumentation.clear();

    const largeItem = buildQueueItemSummary(3, TARGET_LARGE_RESPONSE_BYTES);
    const responseItems = [
      buildQueueItemSummary(1, 8),
      buildQueueItemSummary(2, 8),
      largeItem,
    ] as unknown as GetQueueItemSummariesByItemIdsResult;
    const responseJson = JSON.stringify(responseItems);
    let activeResponseJson = responseJson;
    const responseSizeBytes = new TextEncoder().encode(responseJson).byteLength;
    expect(responseSizeBytes).toBeGreaterThanOrEqual(TARGET_LARGE_RESPONSE_BYTES);

    const fetchMock = vi.fn((input: Request | URL | string) => {
      expect(inputUrl(input)).toContain('/api/v1/queue/default/item_summaries_by_ids');
      return Promise.resolve(new Response(activeResponseJson, { headers: { 'Content-Type': 'application/json' } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const store = createApiStore();
    let maxHeartbeatGapMs = 0;
    let previousHeartbeat = performance.now();
    const heartbeat = setInterval(() => {
      const current = performance.now();
      maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, current - previousHeartbeat);
      previousHeartbeat = current;
    }, 1);
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });

    const started = performance.now();
    const request = store.dispatch(
      queueApi.endpoints.getQueueItemSummariesByItemIds.initiate({
        item_ids: responseItems.map(({ item_id }) => item_id),
      })
    );
    const hydratedItems = await request.unwrap();
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    const rtkQueryMs = performance.now() - started - 5;
    clearInterval(heartbeat);

    const parseStarted = performance.now();
    const directlyParsed = JSON.parse(responseJson) as GetQueueItemSummariesByItemIdsResult;
    const directJsonParseMs = performance.now() - parseStarted;
    const cacheStore = createApiStore();
    const updates: Param0<typeof queueApi.util.upsertQueryEntries> = directlyParsed.map((summary) => ({
      endpointName: 'getQueueItemSummary',
      arg: summary.item_id,
      value: summary,
    }));
    const cacheStarted = performance.now();
    cacheStore.dispatch(queueApi.util.upsertQueryEntries(updates));
    const cacheUpsertMs = performance.now() - cacheStarted;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(hydratedItems).toHaveLength(3);
    expect(directlyParsed).toHaveLength(3);
    expect(
      queueApi.endpoints.getQueueItemSummary.select(3)(store.getState()).data?.field_values?.[0]?.value
    ).toHaveLength(TARGET_LARGE_RESPONSE_BYTES);
    expect(instrumentation.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'api', name: expect.stringContaining('item_summaries_by_ids') }),
        expect.objectContaining({ phase: 'rtk', name: 'item_summaries_by_ids RTK fulfillment' }),
        expect.objectContaining({ phase: 'cache', name: 'item_summaries_by_ids individual cache upserts' }),
      ])
    );

    const threeLargeItems = [
      largeItem,
      { ...largeItem, item_id: 4, batch_id: 'batch-4' },
      { ...largeItem, item_id: 5, batch_id: 'batch-5' },
    ] as unknown as GetQueueItemSummariesByItemIdsResult;
    activeResponseJson = JSON.stringify(threeLargeItems);
    const threeLargeStarted = performance.now();
    const threeLargeRequest = store.dispatch(
      queueApi.endpoints.getQueueItemSummariesByItemIds.initiate({
        item_ids: threeLargeItems.map(({ item_id }) => item_id),
      })
    );
    await threeLargeRequest.unwrap();
    const threeLargeRtkQueryMs = performance.now() - threeLargeStarted;

    console.log(
      [
        'Frontend queue performance diagnostics:',
        `  synthetic response: ${(responseSizeBytes / 1024 / 1024).toFixed(2)} MiB`,
        `  fetch decode + RTK mutation + three cache upserts: ${rtkQueryMs.toFixed(3)} ms`,
        `  frontend event-loop heartbeat gap: ${maxHeartbeatGapMs.toFixed(3)} ms`,
        `  direct JSON.parse: ${directJsonParseMs.toFixed(3)} ms`,
        `  three RTK cache upserts from parsed data: ${cacheUpsertMs.toFixed(3)} ms`,
        `  three-large-item response: ${(activeResponseJson.length / 1024 / 1024).toFixed(2)} MiB`,
        `  fetch decode + RTK hydration for three large items: ${threeLargeRtkQueryMs.toFixed(3)} ms`,
      ].join('\n')
    );

    request.reset();
    threeLargeRequest.reset();
    instrumentation.disable();
  });

  it('measures the unpaginated item-ID response and tag generation for a large queue', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://test' } });
    vi.stubGlobal('localStorage', { getItem: () => null });
    const instrumentation = initializeQueuePerformanceInstrumentation();
    instrumentation.enable();
    instrumentation.clear();

    const itemIds = Array.from({ length: LARGE_HISTORY_COUNT }, (_, index) => LARGE_HISTORY_COUNT - index);
    const responseJson = JSON.stringify({ item_ids: itemIds, total_count: itemIds.length });
    const fetchMock = vi.fn((input: Request | URL | string) => {
      expect(inputUrl(input)).toContain('/api/v1/queue/default/item_ids');
      return Promise.resolve(new Response(responseJson, { headers: { 'Content-Type': 'application/json' } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const store = createApiStore();
    const started = performance.now();
    const request = store.dispatch(queueApi.endpoints.getQueueItemIds.initiate({ order_dir: 'DESC' }));
    const result = await request.unwrap();
    const rtkQueryMs = performance.now() - started;

    const parseStarted = performance.now();
    const directlyParsed = JSON.parse(responseJson);
    const directJsonParseMs = performance.now() - parseStarted;
    const hashStarted = performance.now();
    stableHash(directlyParsed);
    const stableHashMs = performance.now() - hashStarted;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.item_ids).toHaveLength(LARGE_HISTORY_COUNT);
    expect(instrumentation.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'api', name: expect.stringContaining('item_ids') }),
        expect.objectContaining({ phase: 'rtk', name: 'item_ids RTK fulfillment' }),
        expect.objectContaining({ phase: 'tags', name: 'item_ids stable-hash tag generation' }),
      ])
    );

    console.log(
      [
        'Frontend queue-ID performance diagnostics:',
        `  retained item IDs: ${LARGE_HISTORY_COUNT}`,
        `  response: ${(responseJson.length / 1024).toFixed(2)} KiB`,
        `  fetch decode + RTK cache + stable-hash tag generation: ${rtkQueryMs.toFixed(3)} ms`,
        `  direct JSON.parse: ${directJsonParseMs.toFixed(3)} ms`,
        `  direct stableHash of response: ${stableHashMs.toFixed(3)} ms`,
      ].join('\n')
    );

    request.unsubscribe();
    instrumentation.disable();
  });
});
