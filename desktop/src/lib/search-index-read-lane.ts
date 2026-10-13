/** Bound the UI wait, not the underlying transport's lifetime. Tauri invokes
 * may ignore cancellation, so retain their slot until they actually settle. */
export function createSearchIndexReadLane<T>(read: (signal: AbortSignal) => Promise<T>, timeoutMs: number) {
  type Pending = { promise: Promise<T>; timedOut: boolean };
  let pending: Pending | undefined;
  return async (signal: AbortSignal): Promise<T> => {
    signal.throwIfAborted();
    if (pending?.timedOut) throw new Error("Previous diagnostic read is still stopping");
    const owner = new AbortController();
    let observed = pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => { owner.abort(signal.reason); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        const error = new Error("Search diagnostic read timed out");
        if (observed) observed.timedOut = true;
        owner.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      // A superseded read usually settles promptly on abort. Wait for its real
      // completion before starting a fresh read, never reuse its stale result.
      while (pending) {
        observed = pending;
        await Promise.race([pending.promise.catch(() => {}), stopped]);
        owner.signal.throwIfAborted();
      }
      let operation: Promise<T>;
      try { operation = Promise.resolve(read(owner.signal)); }
      catch (error) { operation = Promise.reject(error); }
      const task = { promise: operation, timedOut: false };
      pending = observed = task;
      void operation.finally(() => { if (pending === task) pending = undefined; }).catch(() => {});
      return await Promise.race([operation, stopped]);
    }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  };
}
