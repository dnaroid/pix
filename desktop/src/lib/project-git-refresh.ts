/** Visible explorer only: serialize local reads and stop scheduling on teardown. */
export function createProjectGitRefresh(
  refresh: () => Promise<void>,
  intervalMs = 5_000,
  foreground = () => typeof document === "undefined" || (document.visibilityState === "visible" && document.hasFocus()),
) {
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
    } catch {
      // Git state owns errors; a non-repository must not break file browsing.
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
