/* eslint-disable no-console */

export const QUEUE_PERFORMANCE_STORAGE_KEY = 'invokeai_queue_performance';

type QueuePerformancePhase = 'api' | 'cache' | 'rtk' | 'stall' | 'tags';
type QueuePerformanceDetails = Record<string, boolean | number | string | null | undefined>;

type QueuePerformanceEntry = QueuePerformanceDetails & {
  phase: QueuePerformancePhase;
  name: string;
  startedAtMs: number;
  durationMs: number;
};

type ApiResourceEntry = {
  startedAtMs: number;
  durationMs: number;
  queueDelayMs: number;
  serverWaitMs: number;
  downloadMs: number;
  transferMiB: number;
  url: string;
};

type DurationBuckets = {
  under10Ms: number;
  from10To49Ms: number;
  from50To99Ms: number;
  from100To249Ms: number;
  from250To499Ms: number;
  from500To999Ms: number;
  atLeast1000Ms: number;
};

type QueuePerformanceAggregate = {
  phase: QueuePerformancePhase;
  name: string;
  count: number;
  totalDurationMs: number;
  averageDurationMs: number;
  maxDurationMs: number;
  lastSeenAtMs: number;
  buckets: DurationBuckets;
};

type MutableQueuePerformanceAggregate = Omit<QueuePerformanceAggregate, 'averageDurationMs'>;

type ApiResourceAggregate = {
  name: string;
  count: number;
  averageDurationMs: number;
  maxDurationMs: number;
  averageQueueDelayMs: number;
  maxQueueDelayMs: number;
  averageServerWaitMs: number;
  maxServerWaitMs: number;
  totalTransferMiB: number;
};

type QueuePerformanceReport = {
  entries: QueuePerformanceEntry[];
  slowestEntries: QueuePerformanceEntry[];
  aggregates: QueuePerformanceAggregate[];
  resources: ApiResourceEntry[];
  resourceAggregates: ApiResourceAggregate[];
};

type QueuePerformanceController = {
  readonly enabled: boolean;
  readonly entries: readonly QueuePerformanceEntry[];
  clear: () => void;
  disable: () => void;
  enable: () => void;
  report: () => QueuePerformanceReport;
};

declare global {
  interface Window {
    __invokeQueuePerf?: QueuePerformanceController;
  }
}

const API_URL_PATTERN = /\/api\//i;
const STALL_THRESHOLD_MS = 50;
const HEARTBEAT_INTERVAL_MS = 10;
const ENTRY_MAX_AGE_MS = 10 * 60 * 1_000;
const MAX_RECENT_ENTRIES = 250;
const MAX_SLOWEST_ENTRIES = 25;
const MAX_AGGREGATES = 50;
const MAX_RESOURCE_ENTRIES = 250;
const MAX_RESOURCE_AGGREGATES = 100;

let activeController: QueuePerformanceControllerImpl | null = null;

const createDurationBuckets = (): DurationBuckets => ({
  under10Ms: 0,
  from10To49Ms: 0,
  from50To99Ms: 0,
  from100To249Ms: 0,
  from250To499Ms: 0,
  from500To999Ms: 0,
  atLeast1000Ms: 0,
});

const addDurationToBuckets = (buckets: DurationBuckets, durationMs: number): void => {
  if (durationMs < 10) {
    buckets.under10Ms++;
  } else if (durationMs < 50) {
    buckets.from10To49Ms++;
  } else if (durationMs < 100) {
    buckets.from50To99Ms++;
  } else if (durationMs < 250) {
    buckets.from100To249Ms++;
  } else if (durationMs < 500) {
    buckets.from250To499Ms++;
  } else if (durationMs < 1_000) {
    buckets.from500To999Ms++;
  } else {
    buckets.atLeast1000Ms++;
  }
};

const normalizeApiResourceUrl = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    const pathname = url.pathname.replace(/\/i\/[^/]+/g, '/i/:id').replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id');
    const queryKeys = [...new Set(url.searchParams.keys())].sort();
    return queryKeys.length > 0 ? `${pathname}?${queryKeys.join('&')}` : pathname;
  } catch {
    return rawUrl.split('?')[0] ?? rawUrl;
  }
};

const getApiResourceReport = (): Pick<QueuePerformanceReport, 'resourceAggregates' | 'resources'> => {
  if (typeof performance === 'undefined') {
    return { resourceAggregates: [], resources: [] };
  }
  const cutoff = performance.now() - ENTRY_MAX_AGE_MS;
  const allResources = performance
    .getEntriesByType('resource')
    .filter((entry): entry is PerformanceResourceTiming => {
      return entry.entryType === 'resource' && API_URL_PATTERN.test(entry.name) && entry.startTime >= cutoff;
    })
    .map((entry) => ({
      startedAtMs: entry.startTime,
      durationMs: entry.duration,
      queueDelayMs: Math.max(0, entry.requestStart - entry.startTime),
      serverWaitMs: Math.max(0, entry.responseStart - entry.requestStart),
      downloadMs: Math.max(0, entry.responseEnd - entry.responseStart),
      transferMiB: entry.transferSize / 1024 / 1024,
      url: entry.name,
    }));
  const mutableAggregates = new Map<
    string,
    Omit<ApiResourceAggregate, 'averageDurationMs' | 'averageQueueDelayMs' | 'averageServerWaitMs'> & {
      totalDurationMs: number;
      totalQueueDelayMs: number;
      totalServerWaitMs: number;
    }
  >();
  for (const resource of allResources) {
    const name = normalizeApiResourceUrl(resource.url);
    const aggregate = mutableAggregates.get(name) ?? {
      name,
      count: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      totalQueueDelayMs: 0,
      maxQueueDelayMs: 0,
      totalServerWaitMs: 0,
      maxServerWaitMs: 0,
      totalTransferMiB: 0,
    };
    aggregate.count++;
    aggregate.totalDurationMs += resource.durationMs;
    aggregate.maxDurationMs = Math.max(aggregate.maxDurationMs, resource.durationMs);
    aggregate.totalQueueDelayMs += resource.queueDelayMs;
    aggregate.maxQueueDelayMs = Math.max(aggregate.maxQueueDelayMs, resource.queueDelayMs);
    aggregate.totalServerWaitMs += resource.serverWaitMs;
    aggregate.maxServerWaitMs = Math.max(aggregate.maxServerWaitMs, resource.serverWaitMs);
    aggregate.totalTransferMiB += resource.transferMiB;
    mutableAggregates.set(name, aggregate);
  }
  const resourceAggregates = [...mutableAggregates.values()]
    .map(
      (aggregate): ApiResourceAggregate => ({
        name: aggregate.name,
        count: aggregate.count,
        averageDurationMs: aggregate.totalDurationMs / aggregate.count,
        maxDurationMs: aggregate.maxDurationMs,
        averageQueueDelayMs: aggregate.totalQueueDelayMs / aggregate.count,
        maxQueueDelayMs: aggregate.maxQueueDelayMs,
        averageServerWaitMs: aggregate.totalServerWaitMs / aggregate.count,
        maxServerWaitMs: aggregate.maxServerWaitMs,
        totalTransferMiB: aggregate.totalTransferMiB,
      })
    )
    .sort((a, b) => b.maxDurationMs - a.maxDurationMs)
    .slice(0, MAX_RESOURCE_AGGREGATES);
  return {
    resources: allResources.slice(-MAX_RESOURCE_ENTRIES),
    resourceAggregates,
  };
};

class QueuePerformanceControllerImpl implements QueuePerformanceController {
  #enabled = false;
  #entries: QueuePerformanceEntry[] = [];
  #slowestEntries: QueuePerformanceEntry[] = [];
  #aggregates = new Map<string, MutableQueuePerformanceAggregate>();
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #lastHeartbeat = 0;

  constructor(enabled: boolean) {
    this.#setEnabled(enabled);
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get entries(): readonly QueuePerformanceEntry[] {
    this.#pruneRecentEntries();
    return [...this.#entries];
  }

  enable = (): void => {
    try {
      window.localStorage.setItem(QUEUE_PERFORMANCE_STORAGE_KEY, '1');
    } catch {
      // Storage may be unavailable in privacy-restricted browsing contexts.
    }
    this.#setEnabled(true);
  };

  disable = (): void => {
    try {
      window.localStorage.removeItem(QUEUE_PERFORMANCE_STORAGE_KEY);
    } catch {
      // Storage may be unavailable in privacy-restricted browsing contexts.
    }
    this.#setEnabled(false);
  };

  clear = (): void => {
    this.#entries = [];
    this.#slowestEntries = [];
    this.#aggregates.clear();
    if (typeof performance !== 'undefined') {
      performance.clearResourceTimings();
    }
  };

  report = (): QueuePerformanceReport => {
    this.#pruneRecentEntries();
    const entries = [...this.#entries];
    const slowestEntries = [...this.#slowestEntries];
    const aggregates = [...this.#aggregates.values()]
      .map(
        (aggregate): QueuePerformanceAggregate => ({
          ...aggregate,
          buckets: { ...aggregate.buckets },
          averageDurationMs: aggregate.totalDurationMs / aggregate.count,
        })
      )
      .sort((a, b) => b.maxDurationMs - a.maxDurationMs);
    const { resourceAggregates, resources } = getApiResourceReport();
    console.table(
      entries.map((entry) => ({
        phase: entry.phase,
        name: entry.name,
        duration_ms: Number(entry.durationMs.toFixed(1)),
        started_at_ms: Number(entry.startedAtMs.toFixed(1)),
        ...Object.fromEntries(
          Object.entries(entry).filter(([key]) => !['phase', 'name', 'durationMs', 'startedAtMs'].includes(key))
        ),
      }))
    );
    console.table(
      aggregates.map((aggregate) => ({
        phase: aggregate.phase,
        name: aggregate.name,
        count: aggregate.count,
        average_ms: Number(aggregate.averageDurationMs.toFixed(1)),
        max_ms: Number(aggregate.maxDurationMs.toFixed(1)),
        ...aggregate.buckets,
      }))
    );
    console.table(
      slowestEntries.map((entry) => ({
        phase: entry.phase,
        name: entry.name,
        duration_ms: Number(entry.durationMs.toFixed(1)),
        started_at_ms: Number(entry.startedAtMs.toFixed(1)),
      }))
    );
    console.table(
      resourceAggregates.map((aggregate) => ({
        name: aggregate.name,
        count: aggregate.count,
        average_ms: Number(aggregate.averageDurationMs.toFixed(1)),
        max_ms: Number(aggregate.maxDurationMs.toFixed(1)),
        average_queue_delay_ms: Number(aggregate.averageQueueDelayMs.toFixed(1)),
        max_queue_delay_ms: Number(aggregate.maxQueueDelayMs.toFixed(1)),
        average_server_wait_ms: Number(aggregate.averageServerWaitMs.toFixed(1)),
        max_server_wait_ms: Number(aggregate.maxServerWaitMs.toFixed(1)),
        transfer_mib: Number(aggregate.totalTransferMiB.toFixed(2)),
      }))
    );
    return { entries, slowestEntries, aggregates, resources, resourceAggregates };
  };

  record(entry: QueuePerformanceEntry): void {
    if (!this.#enabled) {
      return;
    }
    this.#pruneRecentEntries(entry.startedAtMs + entry.durationMs);
    this.#entries.push(entry);
    if (this.#entries.length > MAX_RECENT_ENTRIES) {
      this.#entries.splice(0, this.#entries.length - MAX_RECENT_ENTRIES);
    }

    this.#slowestEntries.push(entry);
    this.#slowestEntries.sort((a, b) => b.durationMs - a.durationMs);
    this.#slowestEntries.length = Math.min(this.#slowestEntries.length, MAX_SLOWEST_ENTRIES);

    const aggregateKey = `${entry.phase}\0${entry.name}`;
    const aggregate = this.#aggregates.get(aggregateKey) ?? {
      phase: entry.phase,
      name: entry.name,
      count: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      lastSeenAtMs: 0,
      buckets: createDurationBuckets(),
    };
    aggregate.count++;
    aggregate.totalDurationMs += entry.durationMs;
    aggregate.maxDurationMs = Math.max(aggregate.maxDurationMs, entry.durationMs);
    aggregate.lastSeenAtMs = entry.startedAtMs + entry.durationMs;
    addDurationToBuckets(aggregate.buckets, entry.durationMs);
    this.#aggregates.set(aggregateKey, aggregate);
    if (this.#aggregates.size > MAX_AGGREGATES) {
      const oldestAggregate = [...this.#aggregates.entries()].reduce((oldest, candidate) =>
        candidate[1].lastSeenAtMs < oldest[1].lastSeenAtMs ? candidate : oldest
      );
      this.#aggregates.delete(oldestAggregate[0]);
    }
  }

  #pruneRecentEntries(currentTime = performance.now()): void {
    const cutoff = currentTime - ENTRY_MAX_AGE_MS;
    this.#entries = this.#entries.filter((entry) => entry.startedAtMs >= cutoff);
  }

  #setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) {
      return;
    }
    this.#enabled = enabled;
    if (enabled) {
      this.#lastHeartbeat = performance.now();
      this.#heartbeat = setInterval(() => {
        const current = performance.now();
        const gap = current - this.#lastHeartbeat;
        this.#lastHeartbeat = current;
        if (gap > STALL_THRESHOLD_MS) {
          this.record({
            phase: 'stall',
            name: 'browser event-loop stall',
            startedAtMs: current - gap,
            durationMs: gap,
          });
        }
      }, HEARTBEAT_INTERVAL_MS);
    } else if (this.#heartbeat !== null) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
  }
}

export const initializeQueuePerformanceInstrumentation = (): QueuePerformanceController => {
  if (typeof window === 'undefined') {
    activeController = new QueuePerformanceControllerImpl(false);
    return activeController;
  }
  if (window.__invokeQueuePerf instanceof QueuePerformanceControllerImpl) {
    activeController = window.__invokeQueuePerf;
    return activeController;
  }

  let enabled = false;
  try {
    enabled = window.localStorage.getItem(QUEUE_PERFORMANCE_STORAGE_KEY) === '1';
  } catch {
    // Storage may be unavailable in privacy-restricted browsing contexts.
  }
  activeController = new QueuePerformanceControllerImpl(enabled);
  window.__invokeQueuePerf = activeController;
  return activeController;
};

export const isQueuePerformanceInstrumentationEnabled = (): boolean => activeController?.enabled ?? false;

export const startQueuePerformanceMeasure = (
  phase: QueuePerformancePhase,
  name: string,
  details: QueuePerformanceDetails = {}
): ((finishedDetails?: QueuePerformanceDetails) => void) => {
  const controller = activeController;
  if (!controller?.enabled) {
    return () => undefined;
  }
  const startedAtMs = performance.now();
  let finished = false;
  return (finishedDetails = {}) => {
    if (finished) {
      return;
    }
    finished = true;
    controller.record({
      phase,
      name,
      startedAtMs,
      durationMs: performance.now() - startedAtMs,
      ...details,
      ...finishedDetails,
    });
  };
};
