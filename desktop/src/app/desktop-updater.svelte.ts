import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type DesktopUpdaterStatus = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "error";

type UpdateHandle = Pick<Update, "version" | "body" | "date" | "downloadAndInstall" | "close">;

type DesktopUpdaterDependencies = {
  check: () => Promise<UpdateHandle | null>;
  relaunch: () => Promise<void>;
};

const defaultDependencies: DesktopUpdaterDependencies = {
  check: async () => await check({ timeout: 10_000 }),
  relaunch,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDesktopUpdater(dependencies: DesktopUpdaterDependencies = defaultDependencies) {
  let status = $state<DesktopUpdaterStatus>("idle");
  let available = $state<UpdateHandle | null>(null);
  let downloadedBytes = $state(0);
  let totalBytes = $state<number | null>(null);
  let error = $state<string | null>(null);
  let dismissed = $state(false);
  let generation = 0;
  let disposed = false;

  const visible = $derived(!dismissed && ["available", "downloading", "ready", "error"].includes(status));
  const progress = $derived(totalBytes && totalBytes > 0 ? Math.min(1, downloadedBytes / totalBytes) : null);

  function isCurrent(request: number): boolean {
    return !disposed && request === generation;
  }

  async function closeUpdate(update: UpdateHandle | null): Promise<void> {
    if (!update) return;
    await update.close().catch(() => undefined);
  }

  async function checkNow(): Promise<void> {
    if (disposed || status === "checking" || status === "downloading") return;
    const request = ++generation;
    status = "checking";
    error = null;
    dismissed = false;
    try {
      const next = await dependencies.check();
      if (!isCurrent(request)) {
        await closeUpdate(next);
        return;
      }
      await closeUpdate(available);
      available = next;
      status = next ? "available" : "current";
    } catch (cause) {
      if (!isCurrent(request)) return;
      status = "error";
      error = errorMessage(cause);
    }
  }

  function handleDownloadEvent(event: DownloadEvent): void {
    if (event.event === "Started") {
      downloadedBytes = 0;
      totalBytes = event.data.contentLength ?? null;
    } else if (event.event === "Progress") {
      downloadedBytes += event.data.chunkLength;
    } else if (event.event === "Finished" && totalBytes !== null) {
      downloadedBytes = totalBytes;
    }
  }

  async function install(): Promise<void> {
    const update = available;
    if (!update || disposed || status === "downloading") return;
    const request = ++generation;
    status = "downloading";
    error = null;
    downloadedBytes = 0;
    totalBytes = null;
    try {
      // Windows exits after launching the installer; restartAfterInstall lets the installer reopen Pix.
      // macOS/Linux return here after replacement and expose an explicit Restart action.
      await update.downloadAndInstall(handleDownloadEvent, { timeout: 15 * 60_000, restartAfterInstall: true });
      if (!isCurrent(request)) return;
      status = "ready";
    } catch (cause) {
      if (!isCurrent(request)) return;
      status = "error";
      error = errorMessage(cause);
    }
  }

  async function restart(): Promise<void> {
    if (disposed || status !== "ready") return;
    try {
      await dependencies.relaunch();
    } catch (cause) {
      status = "error";
      error = errorMessage(cause);
    }
  }

  function dismiss(): void {
    dismissed = true;
  }

  function start(): () => void {
    void checkNow();
    return dispose;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    generation += 1;
    const update = available;
    available = null;
    void closeUpdate(update);
  }

  return {
    get status() { return status; },
    get visible() { return visible; },
    get version() { return available?.version ?? null; },
    get notes() { return available?.body ?? null; },
    get progress() { return progress; },
    get downloadedBytes() { return downloadedBytes; },
    get totalBytes() { return totalBytes; },
    get error() { return error; },
    check: checkNow,
    install,
    restart,
    dismiss,
    start,
    dispose,
  };
}

export type DesktopUpdater = ReturnType<typeof createDesktopUpdater>;
