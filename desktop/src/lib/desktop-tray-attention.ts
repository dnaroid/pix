import { invoke, isTauri } from "@tauri-apps/api/core";
import { createFailureStreakReporter } from "./diagnostic-logging";

type Options = {
  isSessionVisible: (sessionId: string | null) => boolean;
  publish?: (attention: boolean) => Promise<unknown>;
  /** Handled publish failures; repeats are suppressed until the next success. */
  reportWarning?: (label: string, error: unknown) => void;
};

/** First retry after a failed publish; doubles per failure up to the cap. */
export const TRAY_ATTENTION_RETRY_MS = 2_000;
export const TRAY_ATTENTION_RETRY_MAX_MS = 60_000;

/** Window-owned unseen events; the native host combines all live windows. */
export function createDesktopTrayAttention(options: Options) {
  const unseen = new Set<string | null>();
  const publish = options.publish ?? ((attention: boolean) => isTauri()
    ? invoke("desktop_set_tray_attention", { attention })
    : Promise.resolve());
  let desired = false;
  // A reloaded webview can inherit native attention from its previous renderer.
  // Publish the initial snapshot, even when it is empty.
  let delivered: boolean | null = null;
  let flushing = false;
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = TRAY_ATTENTION_RETRY_MS;
  const failures = createFailureStreakReporter((error) => options.reportWarning?.("tray:publish", error));

  function clearRetry(): void {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  // Without a retry the badge stays wrong until some unrelated event changes
  // `desired`. One timer at a time, backing off; never after disposal.
  function scheduleRetry(): void {
    if (disposed || retryTimer !== undefined) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, TRAY_ATTENTION_RETRY_MAX_MS);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (!disposed) void flush();
    }, delay);
  }

  async function flush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      while (desired !== delivered) {
        const value = desired;
        await publish(value);
        delivered = value;
      }
      failures.success();
      retryDelay = TRAY_ATTENTION_RETRY_MS;
      clearRetry();
    } catch (error) {
      // Best effort; never block agent work.
      failures.failure(error);
      scheduleRetry();
    } finally {
      flushing = false;
    }
  }

  function update(): void {
    desired = unseen.size > 0;
    void flush();
  }

  function acknowledgeVisible(): void {
    if (disposed) return;
    for (const sessionId of unseen) {
      if (options.isSessionVisible(sessionId)) unseen.delete(sessionId);
    }
    update();
  }

  function reset(): void {
    if (disposed) return;
    unseen.clear();
    update();
  }

  function dispose(): void {
    if (disposed) return;
    reset();
    disposed = true;
    clearRetry();
  }

  return {
    mark(sessionId: string | null): void {
      if (disposed || options.isSessionVisible(sessionId)) return;
      unseen.add(sessionId);
      update();
    },
    clearSession(sessionId: string): void {
      if (disposed) return;
      unseen.delete(sessionId);
      update();
    },
    acknowledgeVisible,
    reset,
    dispose,
    start(): () => void {
      if (disposed) return () => undefined;
      window.addEventListener("focus", acknowledgeVisible);
      document.addEventListener("visibilitychange", acknowledgeVisible);
      acknowledgeVisible();
      return () => {
        window.removeEventListener("focus", acknowledgeVisible);
        document.removeEventListener("visibilitychange", acknowledgeVisible);
        dispose();
      };
    },
  };
}
