export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      cleanup();
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Error("aborted");
  let timeout: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    abort = () => reject(new Error("aborted"));
    signal?.addEventListener("abort", abort, { once: true });
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
    if (abort) signal?.removeEventListener("abort", abort);
  });
}
