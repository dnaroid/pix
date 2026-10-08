/** Bound owned asynchronous continuations even when a transport ignores cancellation. */
export function bounded<T>(signal: AbortSignal, timeoutMs: number | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const owned = AbortSignal.any([signal, controller.signal]);
  return new Promise<T>((resolve, reject) => {
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new Error("Search operation timed out")), timeoutMs);
    const cleanup = () => { clearTimeout(timer); owned.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(owned.reason); };
    owned.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { owned.throwIfAborted(); return run(owned); }).then(value => { cleanup(); if (!owned.aborted) resolve(value); }, error => { cleanup(); reject(error); });
  });
}
