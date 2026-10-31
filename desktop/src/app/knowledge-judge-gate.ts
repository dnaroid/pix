interface WaitingCheck {
  readonly background: boolean;
  readonly signal: AbortSignal;
  readonly operation: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  removeAbort: () => void;
}

/** Pre-save and queued checks share one physical judge slot, including across project resets. */
export function createKnowledgeJudgeGate() {
  const waiting: WaitingCheck[] = [];
  let running: WaitingCheck | undefined;

  function start(next: WaitingCheck): void {
    // Reservation is synchronous; the operation itself starts in a microtask.
    running = next;
    void Promise.resolve().then(() => {
      next.signal.throwIfAborted();
      return next.operation();
    }).then(next.resolve, next.reject).finally(() => {
      next.removeAbort();
      if (running === next) running = undefined;
      queueMicrotask(pump);
    });
  }

  function pump(): void {
    if (running) return;
    const manual = waiting.findIndex(check => !check.background);
    const next = waiting.splice(manual < 0 ? 0 : manual, 1)[0];
    if (!next) return;
    if (next.signal.aborted) {
      next.removeAbort();
      next.reject(next.signal.reason);
      queueMicrotask(pump);
      return;
    }
    start(next);
  }

  function createCheck<T>(operation: () => Promise<T>, signal: AbortSignal, background: boolean) {
    let next!: WaitingCheck;
    const promise = new Promise<T>((resolve, reject) => {
      next = { operation, signal, background,
        resolve: value => resolve(value as T), reject, removeAbort: () => {} };
      const abort = () => {
        const index = waiting.indexOf(next);
        if (index >= 0) waiting.splice(index, 1);
        next.removeAbort();
        reject(signal.reason);
        // Aborting the caller does not release an operation that is still running.
        if (running !== next) queueMicrotask(pump);
      };
      signal.addEventListener("abort", abort, { once: true });
      next.removeAbort = () => signal.removeEventListener("abort", abort);
    });
    return { next, promise };
  }

  return {
    run<T>(operation: () => Promise<T>, signal: AbortSignal, background = false): Promise<T> {
      if (signal.aborted) return Promise.reject(signal.reason);
      const { next, promise } = createCheck(operation, signal, background);
      waiting.push(next);
      queueMicrotask(pump);
      return promise;
    },
    /** Optional metadata work never waits behind a model or an already queued caller. */
    tryRunIfIdle<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> | undefined {
      if (running || waiting.length > 0) return undefined;
      if (signal.aborted) return Promise.reject(signal.reason);
      const { next, promise } = createCheck(operation, signal, true);
      start(next);
      return promise;
    },
  };
}
