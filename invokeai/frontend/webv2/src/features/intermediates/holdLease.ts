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
/** A tab back from a stretch long enough that throttled timers may have missed the heartbeat. */
const RESEND_ON_VISIBLE_AFTER_MS = HEARTBEAT_MS;
const CHANGE_DEBOUNCE_MS = 250;

type Batch = { images: string[]; videos: string[] };
/** Each batch's request body, which also serves as its signature. */
type Plan = string[];
type Slot = 0 | 1;

const sameNames = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
  left.size === right.size && [...left].every((name) => right.has(name));

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
  /** Current names to hold, in any order; returning the previous object again means nothing changed. */
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
  let planned: { held: HeldMediaNames; images: Set<string>; plan: Plan; videos: Set<string> } | null = null;
  // Releases must authenticate as the account that took the lease, even after sign-out cleared the session.
  let leaseToken: string | null = null;

  const batchLeaseId = (slot: Slot, index: number): string => `${leaseId}.${slot}-${index}`;
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

  const putBatch = async (slot: Slot, index: number, body: string): Promise<boolean> => {
    if (isStopped()) {
      return false;
    }
    const token = getHttpAuthToken();
    try {
      await apiFetch(holdPath(batchLeaseId(slot, index)), {
        body,
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
    leaseSignatures[slot][index] = body;
    return true;
  };

  /** Sorting and serialising up to 50k names per kind is the expensive part; an unchanged set reuses its plan. */
  const planFor = (held: HeldMediaNames): Plan => {
    if (planned?.held === held) {
      return planned.plan;
    }
    const imageSet = new Set(held.images);
    const videoSet = new Set(held.videos);
    if (planned && sameNames(imageSet, planned.images) && sameNames(videoSet, planned.videos)) {
      planned.held = held;
      return planned.plan;
    }
    const plan = partitionHeldMediaNames([...imageSet].sort(), [...videoSet].sort()).map((batch) =>
      JSON.stringify(batch)
    );
    planned = { held, images: imageSet, plan, videos: videoSet };
    return plan;
  };

  const sendOnce = async (refresh: boolean): Promise<void> => {
    const bodies = planFor(read());
    if (!bodies.length) {
      await releaseSlot(0);
      await releaseSlot(1);
      activeSlot = null;
      return;
    }
    const current = activeSlot === null ? null : leaseSignatures[activeSlot];
    let trimActive = false;
    if (current && current.length === bodies.length && bodies.every((value, i) => value === current[i])) {
      if (refresh) {
        let refreshed = true;
        for (let index = 0; index < bodies.length; index += 1) {
          refreshed = (await putBatch(activeSlot!, index, bodies[index]!)) && refreshed;
        }
        if (refreshed) {
          lastSentAt = Date.now();
        }
      }
      trimActive = true;
    } else {
      const nextSlot: Slot = activeSlot === 0 ? 1 : 0;
      let staged = true;
      for (let index = 0; index < bodies.length; index += 1) {
        staged = (await putBatch(nextSlot, index, bodies[index]!)) && staged;
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
        await releaseSlot(activeSlot, bodies.length);
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
