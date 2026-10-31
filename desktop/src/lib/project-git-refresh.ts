import { createFailureStreakReporter } from "./diagnostic-logging";

/** Visible explorer only: serialize local reads and stop scheduling on teardown. */
export function createProjectGitRefresh(
  refresh: () => Promise<void>,
  intervalMs = 5_000,
  foreground = () => typeof document === "undefined" || (document.visibilityState === "visible" && document.hasFocus()),
  /** Logged once per failure streak, not on every poll. */
  reportFailure?: (error: unknown) => void,
) {
  const failures = createFailureStreakReporter((error) => reportFailure?.(error));
  let disposed = false;
  let running = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function request(): Promise<void> {
    if (disposed) return;
    if (running) {
      pending = true;
      return;
    }
    clearTimeout(timer);
    running = true;
    try {
      await refresh();
      failures.success();
    } catch (error) {
      // Git state owns errors; a non-repository must not break file browsing.
      if (!disposed) failures.failure(error);
    } finally {
      running = false;
      if (!disposed) {
        if (pending) {
          pending = false;
          void request();
        } else timer = setTimeout(() => void request(), foreground() ? intervalMs : 30_000);
      }
    }
  }

  return {
    request,
    dispose() {
      disposed = true;
      pending = false;
      clearTimeout(timer);
    },
  };
}
