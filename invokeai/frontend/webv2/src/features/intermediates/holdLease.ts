import type { AccountScope } from '@platform/state/accountLifecycle';

import { createUuid } from '@platform/browser/randomUuid';
import { apiFetch, getHttpAuthToken } from '@platform/transport/http';

export interface HeldMediaNames {
  images: readonly string[];
  videos: readonly string[];
}

/** Mirrors the server's per-kind `max_length` on a hold request. */
export const MAX_HOLD_NAMES_PER_KIND = 50_000;

/** The server keeps a lease for 15 minutes; refreshing well inside that survives a missed beat. */
const HEARTBEAT_MS = 5 * 60_000;
const RESEND_ON_VISIBLE_AFTER_MS = 60_000;
const CHANGE_DEBOUNCE_MS = 250;

type Batch = { images: string[]; videos: string[] };
type Slot = 0 | 1;

const holdPath = (leaseId: string): string => `/api/v1/intermediates/holds/${encodeURIComponent(leaseId)}`;

/** Each request stays within the per-kind limit; sorted input keeps unchanged batches byte-identical. */
export const partitionHeldMediaNames = (images: readonly string[], videos: readonly string[]): Batch[] => {
  const batches: Batch[] = [];
  for (let start = 0; start < Math.max(images.length, videos.length); start += MAX_HOLD_NAMES_PER_KIND) {
    batches.push({
      images: images.slice(start, start + MAX_HOLD_NAMES_PER_KIND),
      videos: videos.slice(start, start + MAX_HOLD_NAMES_PER_KIND),
    });
  }
  return batches;
};

/**
 * Keeps the media an open editor still needs (unsaved content, undo state) out of cleanup for as long as the tab is
 * alive. Replacement batches are staged under a second lease set before the old one is released, so a name never
 * goes unprotected mid-update. Leases are released on dispose and on `pagehide`, with `keepalive` so the release
 * survives the page; the server's 15-minute expiry bounds anything a crash leaves behind.
 */
export const startIntermediatesHoldLease = ({
  owner,
  read,
  subscribe,
}: {
  owner: AccountScope;
  /** Current names to hold, in any order. */
  read: () => HeldMediaNames;
  /** Notifies when `read` may return something new. */
  subscribe: (onChange: () => void) => () => void;
}): (() => void) => {
  const leaseId = createUuid();
  const leaseSignatures: [string[], string[]] = [[], []];
  let activeSlot: Slot | null = null;
  let disposed = false;
  let inFlight = false;
  let pending = false;
  let pendingRefresh = false;
  let lastSentAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Releases must authenticate as the account that took the lease, even after sign-out cleared the session.
  let leaseToken: string | null = null;

  const batchLeaseId = (slot: Slot, index: number): string => `${leaseId}-${slot}-${index}`;
  const isStopped = (): boolean => disposed || owner.signal.aborted;

  const fireRelease = (id: string): void => {
    void apiFetch(holdPath(id), {
      headers: leaseToken ? { Authorization: `Bearer ${leaseToken}` } : undefined,
      keepalive: true,
      method: 'DELETE',
    }).catch(() => undefined);
  };

  const releaseEverything = (): void => {
    for (const slot of [0, 1] as const) {
      leaseSignatures[slot].forEach((signature, index) => {
        if (signature) {
          fireRelease(batchLeaseId(slot, index));
        }
      });
      leaseSignatures[slot] = [];
    }
    activeSlot = null;
  };

  const releaseSlot = async (slot: Slot, from = 0): Promise<void> => {
    const signatures = leaseSignatures[slot];
    for (let index = from; index < signatures.length; index += 1) {
      if (!signatures[index] || isStopped()) {
        continue;
      }
      try {
        await apiFetch(holdPath(batchLeaseId(slot, index)), { method: 'DELETE', signal: owner.signal });
        signatures[index] = '';
      } catch {
        // Keep the signature so a later send retries the release.
      }
    }
    while (signatures.at(-1) === '') {
      signatures.pop();
    }
  };

  const putBatch = async (slot: Slot, index: number, batch: Batch): Promise<boolean> => {
    if (isStopped()) {
      return false;
    }
    const token = getHttpAuthToken();
    try {
      await apiFetch(holdPath(batchLeaseId(slot, index)), {
        body: JSON.stringify(batch),
        headers: { 'Content-Type': 'application/json' },
        method: 'PUT',
        signal: owner.signal,
      });
    } catch {
      return false;
    }
    leaseToken = token;
    if (disposed) {
      // Dispose already released what it knew about; this lease landed after.
      fireRelease(batchLeaseId(slot, index));
      return false;
    }
    leaseSignatures[slot][index] = JSON.stringify([batch.images, batch.videos]);
    return true;
  };

  const sendOnce = async (refresh: boolean): Promise<void> => {
    const held = read();
    const images = [...new Set(held.images)].sort();
    const videos = [...new Set(held.videos)].sort();
    if (!images.length && !videos.length) {
      await releaseSlot(0);
      await releaseSlot(1);
      activeSlot = null;
      return;
    }
    const batches = partitionHeldMediaNames(images, videos);
    const signatures = batches.map((batch) => JSON.stringify([batch.images, batch.videos]));
    const current = activeSlot === null ? null : leaseSignatures[activeSlot];
    let trimActive = false;
    if (current && current.length === signatures.length && signatures.every((value, i) => value === current[i])) {
      if (refresh) {
        let refreshed = true;
        for (let index = 0; index < batches.length; index += 1) {
          refreshed = (await putBatch(activeSlot!, index, batches[index]!)) && refreshed;
        }
        if (refreshed) {
          lastSentAt = Date.now();
        }
      }
      trimActive = true;
    } else {
      const nextSlot: Slot = activeSlot === 0 ? 1 : 0;
      let staged = true;
      for (let index = 0; index < batches.length; index += 1) {
        staged = (await putBatch(nextSlot, index, batches[index]!)) && staged;
      }
      if (staged && !isStopped()) {
        const oldSlot = activeSlot;
        activeSlot = nextSlot;
        lastSentAt = Date.now();
        trimActive = true;
        if (oldSlot !== null) {
          await releaseSlot(oldSlot);
        }
      }
    }
    if (activeSlot !== null) {
      if (trimActive) {
        await releaseSlot(activeSlot, batches.length);
      }
      await releaseSlot(activeSlot === 0 ? 1 : 0);
    }
  };

  const send = async (refresh = false): Promise<void> => {
    if (isStopped()) {
      return;
    }
    if (inFlight) {
      pending = true;
      pendingRefresh ||= refresh;
      return;
    }
    inFlight = true;
    try {
      do {
        pending = false;
        const mustRefresh = refresh || pendingRefresh;
        refresh = false;
        pendingRefresh = false;
        await sendOnce(mustRefresh);
      } while (pending && !isStopped());
    } finally {
      inFlight = false;
    }
  };

  const schedule = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      void send();
    }, CHANGE_DEBOUNCE_MS);
  };
  const onVisibilityChange = (): void => {
    if (
      document.visibilityState === 'visible' &&
      (activeSlot === null || Date.now() - lastSentAt >= RESEND_ON_VISIBLE_AFTER_MS)
    ) {
      void send(true);
    }
  };
  const onPageHide = (): void => releaseEverything();
  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) {
      void send();
    }
  };

  const unsubscribe = subscribe(schedule);
  const heartbeat = setInterval(() => void send(true), HEARTBEAT_MS);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  void send();

  return () => {
    disposed = true;
    unsubscribe();
    clearInterval(heartbeat);
    if (timer !== null) {
      clearTimeout(timer);
    }
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    releaseEverything();
  };
};
