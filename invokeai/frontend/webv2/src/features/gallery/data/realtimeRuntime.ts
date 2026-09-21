import type { BackendConnectionStatus } from '@platform/transport/types';

import { captureAccountScope, isAccountScopeCurrent } from '@platform/state/accountLifecycle';

export interface GalleryRealtimeBackend {
  on(event: string, handler: (payload: never) => void): () => void;
  onConnectionChange(handler: (status: BackendConnectionStatus) => void): () => void;
}

export interface GalleryRealtimeRuntime {
  dispose(): void;
  start(): void;
}

/**
 * Refreshes the Gallery read model for content that arrives without a queue
 * event: uploads through the API from scripts, other clients, or other tabs,
 * and anything that landed while the socket was down.
 *
 * Uploads are not paced by generation the way queue events are, and every
 * invalidation pass cancels the page fetches under the user. So passes are held
 * at least `minIntervalMs` apart: an event arriving while one is pending rides
 * along, and one arriving after a pass waits out the rest of the interval, so a
 * trailing pass is always guaranteed. Uploads spaced wider than that interval
 * still get a pass each, which is the point -- each one is new media to show.
 */
export const createGalleryRealtimeRuntime = ({
  backend,
  coalesceMs = 250,
  invalidate,
  minIntervalMs = 1000,
}: {
  backend: GalleryRealtimeBackend;
  coalesceMs?: number;
  invalidate: () => void | Promise<void>;
  minIntervalMs?: number;
}): GalleryRealtimeRuntime => {
  const owner = captureAccountScope();
  const detachers: Array<() => void> = [];
  let invalidationTimer: ReturnType<typeof setTimeout> | null = null;
  let lastInvalidatedAt = Number.NEGATIVE_INFINITY;
  let isStarted = false;
  const isActive = (): boolean => isStarted && isAccountScopeCurrent(owner);

  const scheduleInvalidation = (): void => {
    if (!isActive() || invalidationTimer !== null) {
      return;
    }

    // `performance.now()` rather than `Date.now()`: a wall clock that steps backwards (NTP
    // correction after resume, VM resync) would otherwise push this delay out by the size of
    // the step, and the guard above means that one pending timer absorbs every event until it
    // fires.
    const delay = Math.max(coalesceMs, lastInvalidatedAt + minIntervalMs - performance.now());

    invalidationTimer = setTimeout(() => {
      invalidationTimer = null;

      if (isActive()) {
        lastInvalidatedAt = performance.now();
        void invalidate();
      }
    }, delay);
  };

  const start = (): void => {
    if (isStarted || !isAccountScopeCurrent(owner)) {
      return;
    }

    isStarted = true;

    // The hub replays the current status synchronously on subscribe. A boot that
    // reaches 'connected' from 'connecting' has missed nothing, so it must not
    // cancel and refetch pages that are still loading. A hub that is already
    // 'disconnected' when this mounts is the other case: events were missed, so
    // its next 'connected' is a genuine reconnect.
    let previousStatus: BackendConnectionStatus | null = null;

    detachers.push(
      backend.on('image_uploaded', scheduleInvalidation),
      backend.on('video_uploaded', scheduleInvalidation),
      backend.onConnectionChange((status) => {
        const isReconnect = previousStatus === 'disconnected' && status === 'connected';

        previousStatus = status;

        if (isReconnect) {
          scheduleInvalidation();
        }
      })
    );
  };

  const dispose = (): void => {
    isStarted = false;

    for (const detach of detachers.splice(0)) {
      detach();
    }

    if (invalidationTimer !== null) {
      clearTimeout(invalidationTimer);
      invalidationTimer = null;
    }
  };

  return { dispose, start };
};
