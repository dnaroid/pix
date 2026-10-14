import { invoke, isTauri } from "@tauri-apps/api/core";

type Options = {
  isSessionVisible: (sessionId: string | null) => boolean;
  publish?: (attention: boolean) => Promise<unknown>;
};

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

  async function flush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      while (desired !== delivered) {
        const value = desired;
        await publish(value);
        delivered = value;
      }
    } catch {
      // Best effort; a subsequent update retries. Never block agent work.
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
