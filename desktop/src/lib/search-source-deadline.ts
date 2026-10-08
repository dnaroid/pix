export const SEARCH_SOURCE_TIMEOUT_MS = 20_000;

export function pendingSearchNotice(label: string): string {
  return `${label} search is taking longer than 20 seconds. Results will be added when ready.`;
}

/** End initial UI waiting, but keep slow work owned until completion or cancellation. */
export function runSearchSource(
  signal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<void>,
  onSlow: () => void,
  onComplete: (error?: unknown) => void,
): Promise<"completed" | "pending" | "cancelled"> {
  if (signal.aborted) return Promise.resolve("cancelled");
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      finished = true;
      cleanup();
      resolve("cancelled");
    };
    const timer = setTimeout(() => {
      if (finished || signal.aborted) return;
      try { onSlow(); resolve("pending"); }
      catch (error) { reject(error); }
    }, SEARCH_SOURCE_TIMEOUT_MS);
    const complete = (error?: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      try {
        if (!signal.aborted) onComplete(error);
        resolve(signal.aborted ? "cancelled" : "completed");
      } catch (error) { reject(error); }
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => signal.aborted ? undefined : operation(signal)).then(
      () => complete(), error => complete(error),
    );
  });
}
