import { createFailureStreakReporter } from "./diagnostic-logging";

interface RefreshActivity {
  window: Pick<Window, "addEventListener" | "removeEventListener">;
  document: Pick<Document, "hidden" | "hasFocus" | "addEventListener" | "removeEventListener">;
}

/** Poll only the mounted, foreground explorer; activity listeners share its lifetime. */
export function createProjectFilesRefresh(
  refresh: () => Promise<void>,
  activity: RefreshActivity = { window, document },
  intervalMs = 5_000,
  /** Logged once per failure streak; the owning view still shows listing errors. */
  reportFailure?: (error: unknown) => void,
) {
  const failures = createFailureStreakReporter((error) => reportFailure?.(error));
  let disposed = false;
  let running = false;
  let pending = false;
  let active = !activity.document.hidden && activity.document.hasFocus();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedule(): void {
    clearTimeout(timer);
    if (active && !disposed) timer = setTimeout(() => void request(), intervalMs);
  }

  async function request(): Promise<void> {
    if (disposed || !active) return;
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
      // Directory state owns listing errors; keep retrying after transient failures.
      if (!disposed) failures.failure(error);
    } finally {
      running = false;
      if (pending && active && !disposed) {
        pending = false;
        void request();
      } else schedule();
    }
  }

  function updateActivity(): void {
    const nextActive = !activity.document.hidden && activity.document.hasFocus();
    if (active === nextActive) return;
    active = nextActive;
    if (active) void request();
    else {
      pending = false;
      clearTimeout(timer);
    }
  }

  activity.window.addEventListener("focus", updateActivity);
  activity.window.addEventListener("blur", updateActivity);
  activity.document.addEventListener("visibilitychange", updateActivity);
  // Initial/workspace loading already belongs to the tree controller.
  schedule();

  return {
    dispose(): void {
      disposed = true;
      pending = false;
      clearTimeout(timer);
      activity.window.removeEventListener("focus", updateActivity);
      activity.window.removeEventListener("blur", updateActivity);
      activity.document.removeEventListener("visibilitychange", updateActivity);
    },
  };
}
