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
  let refreshingGeneration: number | undefined;

  async function refresh() {
    if (refreshingGeneration === generation) return;
    const current = generation;
    refreshingGeneration = current;
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
      if (refreshingGeneration === current) refreshingGeneration = undefined;
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
    const current = generation;
    restarting = true;
    try {
      await dependencies.invoke("desktop_watch_restart");
    } catch {
      if (current !== generation) return;
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
