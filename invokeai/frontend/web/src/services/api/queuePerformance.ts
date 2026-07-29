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
  durationMs: number;
  serverWaitMs: number;
  downloadMs: number;
  transferMiB: number;
  url: string;
};

type QueuePerformanceController = {
  readonly enabled: boolean;
  readonly entries: readonly QueuePerformanceEntry[];
  clear: () => void;
  disable: () => void;
  enable: () => void;
  report: () => { entries: QueuePerformanceEntry[]; resources: ApiResourceEntry[] };
};

declare global {
  interface Window {
    __invokeQueuePerf?: QueuePerformanceController;
  }
}

const API_URL_PATTERN = /\/api\//i;
const STALL_THRESHOLD_MS = 50;
const HEARTBEAT_INTERVAL_MS = 10;

let activeController: QueuePerformanceControllerImpl | null = null;

const getApiResourceEntries = (): ApiResourceEntry[] => {
  if (typeof performance === 'undefined') {
    return [];
  }
  return performance
    .getEntriesByType('resource')
    .filter((entry): entry is PerformanceResourceTiming => {
      return entry.entryType === 'resource' && API_URL_PATTERN.test(entry.name);
    })
    .map((entry) => ({
      durationMs: entry.duration,
      serverWaitMs: entry.responseStart - entry.requestStart,
      downloadMs: entry.responseEnd - entry.responseStart,
      transferMiB: entry.transferSize / 1024 / 1024,
      url: entry.name,
    }));
};

class QueuePerformanceControllerImpl implements QueuePerformanceController {
  #enabled = false;
  #entries: QueuePerformanceEntry[] = [];
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #lastHeartbeat = 0;

  constructor(enabled: boolean) {
    this.#setEnabled(enabled);
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get entries(): readonly QueuePerformanceEntry[] {
    return this.#entries;
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
    if (typeof performance !== 'undefined') {
      performance.clearResourceTimings();
    }
  };

  report = (): { entries: QueuePerformanceEntry[]; resources: ApiResourceEntry[] } => {
    const entries = [...this.#entries];
    const resources = getApiResourceEntries();
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
      resources.map((entry) => ({
        duration_ms: Number(entry.durationMs.toFixed(1)),
        server_wait_ms: Number(entry.serverWaitMs.toFixed(1)),
        download_ms: Number(entry.downloadMs.toFixed(1)),
        transfer_mib: Number(entry.transferMiB.toFixed(2)),
        url: entry.url,
      }))
    );
    return { entries, resources };
  };

  record(entry: QueuePerformanceEntry): void {
    if (this.#enabled) {
      this.#entries.push(entry);
    }
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
