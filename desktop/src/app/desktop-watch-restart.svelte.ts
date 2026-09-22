import { invoke } from "@tauri-apps/api/core";

const POLL_MS = 1_000;

type DesktopWatchRestartDependencies = {
  invoke: <T>(command: string) => Promise<T>;
};

const defaultDependencies: DesktopWatchRestartDependencies = { invoke };

/** Development-only handoff to a newer watch:all artifact. Release builds receive no state file. */
export function createDesktopWatchRestart(dependencies: DesktopWatchRestartDependencies = defaultDependencies) {
  let available = $state(false);
  let restarting = $state(false);
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh() {
    try {
      available = await dependencies.invoke<boolean>("desktop_watch_restart_available");
    } catch {
      available = false;
    }
  }

  function start() {
    void refresh();
    timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
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
    start,
    restart,
  };
}
