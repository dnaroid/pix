import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), warn: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./diagnostic-logging", async importOriginal => ({
  ...await importOriginal<typeof import("./diagnostic-logging")>(),
  createDiagnosticLogger: () => ({ warn: mocks.warn }),
}));
import { createSleepPreference, readSleepHours } from "./sleep-preference.svelte";

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe("sleep duration preference", () => {
  it("defaults to six hours for omitted, malformed and out-of-range settings", () => {
    for (const source of ["{}", "null", '{"desktop":{}}', '{"desktop":{"sleepHours":8},oops}']) {
      expect(readSleepHours(source)).toBe(6);
    }
    for (const sleepHours of [null, "8", true, 0, -1, 0.25, 25]) {
      expect(readSleepHours(JSON.stringify({ desktop: { sleepHours } }))).toBe(6);
    }
    for (const sleepHours of [0.5, 6, 7.5, 24]) {
      expect(readSleepHours(`{// comment\n"desktop":{"sleepHours":${sleepHours},},}`)).toBe(sleepHours);
    }
  });

  it("reloads on save/focus, ignores stale completions and removes listeners", async () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    let resolve!: (value: { content: string }) => void;
    mocks.invoke.mockReturnValueOnce(new Promise(r => { resolve = r; }))
      .mockResolvedValueOnce({ content: '{"desktop":{"sleepHours":8}}' });
    const preference = createSleepPreference();
    expect(preference.hours).toBe(6);
    const stop = preference.mount();
    expect(mocks.invoke).toHaveBeenCalledWith("read_user_config", { kind: "desktop" });
    target.dispatchEvent(new Event("pix-desktop-config-changed"));
    await Promise.resolve();
    expect(preference.hours).toBe(8);
    resolve({ content: '{"desktop":{"sleepHours":4}}' });
    await Promise.resolve();
    expect(preference.hours).toBe(8);
    mocks.invoke.mockResolvedValueOnce({ content: "{}" });
    target.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(preference.hours).toBe(6);
    stop();
    target.dispatchEvent(new Event("focus"));
    target.dispatchEvent(new Event("pix-desktop-config-changed"));
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
  });

  it("retains the last value and logs once per failure streak without sensitive payloads", async () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    mocks.invoke.mockResolvedValueOnce({ content: '{"desktop":{"sleepHours":8}}' })
      .mockRejectedValue(new Error("private config content"));
    const preference = createSleepPreference();
    const stop = preference.mount();
    await Promise.resolve();
    for (let i = 0; i < 2; i++) {
      target.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    }
    expect(preference.hours).toBe(8);
    expect(mocks.warn).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledWith("usage:sleep-preference", expect.any(Error));
    expect(mocks.warn.mock.calls[0]![1].message).not.toContain("private");
    stop();
  });

  it.each([false, true])("ignores success or failure after teardown (failure=%s)", async fail => {
    vi.stubGlobal("window", new EventTarget());
    let resolve!: (value: { content: string }) => void;
    let reject!: (error: Error) => void;
    mocks.invoke.mockReturnValueOnce(new Promise((res, rej) => { resolve = res; reject = rej; }));
    const preference = createSleepPreference();
    const stop = preference.mount();
    stop();
    if (fail) reject(new Error("closed"));
    else resolve({ content: '{"desktop":{"sleepHours":8}}' });
    await Promise.resolve();
    expect(preference.hours).toBe(6);
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
