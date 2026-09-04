export type ExclusiveLockResult =
  | { kind: 'acquired'; release(): Promise<void> }
  | { kind: 'contended' | 'unavailable' };

export const acquireExclusiveLock = (name: string, lockManager?: LockManager): Promise<ExclusiveLockResult> => {
  let manager = lockManager;
  if (!manager) {
    try {
      manager = typeof navigator === 'undefined' ? undefined : navigator.locks;
    } catch {
      manager = undefined;
    }
  }
  if (!manager) {
    return Promise.resolve({ kind: 'unavailable' });
  }

  return new Promise((resolve) => {
    let didResolve = false;
    let releaseHold: () => void = () => undefined;
    const hold = new Promise<void>((release) => {
      releaseHold = release;
    });

    try {
      let request: Promise<void>;
      request = manager
        .request(name, { ifAvailable: true, mode: 'exclusive' }, async (lock) => {
          if (!lock) {
            didResolve = true;
            resolve({ kind: 'contended' });
            return;
          }
          let isReleased = false;
          didResolve = true;
          resolve({
            kind: 'acquired',
            async release() {
              if (!isReleased) {
                isReleased = true;
                releaseHold();
              }
              await request;
            },
          });
          await hold;
        })
        .catch(() => {
          if (!didResolve) {
            didResolve = true;
            resolve({ kind: 'unavailable' });
          }
        });
    } catch {
      didResolve = true;
      resolve({ kind: 'unavailable' });
    }
  });
};
