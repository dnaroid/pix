import { describe, expect, it, vi } from "vitest";
import { createDesktopUpdater } from "./desktop-updater.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function update(version = "2.0.1") {
  return {
    version,
    body: "notes",
    date: "2026-09-18T20:00:00Z",
    close: vi.fn(async () => undefined),
    downloadAndInstall: vi.fn(async (onEvent?: (event: { event: string; data?: Record<string, number> }) => void) => {
      onEvent?.({ event: "Started", data: { contentLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 40 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 60 } });
      onEvent?.({ event: "Finished" });
    }),
  };
}

describe("desktop updater", () => {
  it("checks, downloads, installs, tracks progress, and relaunches", async () => {
    const candidate = update();
    const restart = vi.fn(async () => undefined);
    const updater = createDesktopUpdater({ check: async () => candidate as never, relaunch: restart });

    await updater.check();
    expect(updater.status).toBe("available");
    expect(updater.version).toBe("2.0.1");
    expect(updater.visible).toBe(true);

    await updater.install();
    expect(candidate.downloadAndInstall).toHaveBeenCalledOnce();
    expect(updater.status).toBe("ready");
    expect(updater.progress).toBe(1);
    expect(updater.downloadedBytes).toBe(100);

    await updater.restart();
    expect(restart).toHaveBeenCalledOnce();
    updater.dispose();
  });

  it("closes a late update and ignores completion after disposal", async () => {
    const pending = deferred<ReturnType<typeof update> | null>();
    const candidate = update();
    const updater = createDesktopUpdater({ check: async () => await pending.promise as never, relaunch: async () => undefined });

    const checking = updater.check();
    expect(updater.status).toBe("checking");
    updater.dispose();
    pending.resolve(candidate);
    await checking;

    expect(candidate.close).toHaveBeenCalledOnce();
    expect(updater.visible).toBe(false);
  });

  it("does not launch two concurrent installs", async () => {
    const release = deferred<void>();
    const candidate = update();
    candidate.downloadAndInstall.mockImplementation(async () => await release.promise);
    const updater = createDesktopUpdater({ check: async () => candidate as never, relaunch: async () => undefined });
    await updater.check();

    const first = updater.install();
    const second = updater.install();
    expect(candidate.downloadAndInstall).toHaveBeenCalledOnce();
    release.resolve();
    await Promise.all([first, second]);
    expect(updater.status).toBe("ready");
    updater.dispose();
  });

  it("surfaces check failures without throwing into application startup", async () => {
    const updater = createDesktopUpdater({
      check: async () => { throw new Error("network unavailable"); },
      relaunch: async () => undefined,
    });
    await updater.check();
    expect(updater.status).toBe("error");
    expect(updater.error).toContain("network unavailable");
    expect(updater.visible).toBe(true);
    updater.dismiss();
    expect(updater.visible).toBe(false);
    updater.dispose();
  });
});
