import { invoke } from "@tauri-apps/api/core";

const POLL_MS = 1_000;

export type DesktopBuildStatus = "idle" | "queued" | "building" | "failed";
type DesktopWatchStatus = { available: boolean; buildStatus: DesktopBuildStatus };

type DesktopWatchRestartDependencies = {
  invoke: <T>(command: string) => Promise<T>;
};

const defaultDependencies: DesktopWatchRestartDependencies = { invoke };

/** Development-only handoff to a newer watch:all artifact. Release builds receive no state file. */
export function createDesktopWatchRestart(dependencies: DesktopWatchRestartDependencies = defaultDependencies) {
  let available = $state(false);
  let restarting = $state(false);
  let buildStatus = $state<DesktopBuildStatus>("idle");
  let timer: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let refreshing = false;

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    const current = generation;
    try {
      const status = await dependencies.invoke<DesktopWatchStatus>("desktop_watch_status");
      if (current !== generation) return;
      available = status.available;
      buildStatus = status.buildStatus;
    } catch {
      if (current !== generation) return;
      available = false;
      buildStatus = "idle";
    } finally {
      refreshing = false;
    }
  }

  function start() {
    if (timer) clearInterval(timer);
    const current = ++generation;
    void refresh();
    timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      if (current !== generation) return;
      generation++;
      if (timer) clearInterval(timer);
      timer = undefined;
    };
  }

  async function restart() {
    if (!available || restarting) return;
    restarting = true;
    try {
      await dependencies.invoke("desktop_watch_restart");
    } catch {
      restarting = false;
      await refresh();
    }
  }

  return {
    get available() { return available; },
    get restarting() { return restarting; },
    get buildStatus() { return buildStatus; },
    start,
    restart,
  };
}
