/**
 * A cancellable, non-blocking pause between subscription-account attempts.
 * Remove the abort handler and clear the timeout on either completion path.
 */
export function waitForRotationDelay(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (delayMs <= 0) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (completed: boolean): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(completed);
    };
    const abort = (): void => finish(false);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      finish(false);
      return;
    }
    timer = setTimeout(() => finish(true), delayMs);
  });
}
