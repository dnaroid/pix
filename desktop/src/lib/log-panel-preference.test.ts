import { afterEach, describe, expect, it, vi } from "vitest";
const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
import { createLogPanelPreference, readLogPanelEnabled } from "./log-panel-preference.svelte";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("log panel preference", () => {
  it("is strictly opt-in and accepts JSONC but not malformed config", () => {
    for (const source of ["{}", "null", '{"desktop":{}}', '{"desktop":{"logPanelEnabled":"true"}}', '{"desktop":{"logPanelEnabled":true},oops}']) {
      expect(readLogPanelEnabled(source)).toBe(false);
    }
    expect(readLogPanelEnabled('{//comment\n"desktop":{"logPanelEnabled":true,},}')).toBe(true);
  });
  it("refreshes on saved settings/focus, ignores stale reads and removes listeners", async () => {
    const window = new EventTarget();
    vi.stubGlobal("window", window);
    let resolve!: (value: unknown) => void;
    tauri.invoke.mockReturnValueOnce(new Promise(r => { resolve = r; })).mockResolvedValue({ content: '{"desktop":{"logPanelEnabled":true}}' });
    const disabled = vi.fn();
    const preference = createLogPanelPreference(disabled);
    expect(preference.enabled).toBe(false);
    const dispose = preference.mount();
    window.dispatchEvent(new Event("pix-desktop-config-changed"));
    await Promise.resolve();
    expect(preference.enabled).toBe(true);
    resolve({ content: "{}" });
    await Promise.resolve();
    expect(preference.enabled).toBe(true);
    expect(disabled).not.toHaveBeenCalled();
    tauri.invoke.mockResolvedValueOnce({ content: "{}" });
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(preference.enabled).toBe(false);
    expect(disabled).toHaveBeenCalledOnce();
    dispose();
    window.dispatchEvent(new Event("focus"));
    expect(tauri.invoke).toHaveBeenCalledTimes(3);
  });
  it("fails closed and ignores completion after unmount", async () => {
    vi.stubGlobal("window", new EventTarget());
    tauri.invoke.mockRejectedValueOnce("unreadable");
    const disabled = vi.fn();
    const preference = createLogPanelPreference(disabled);
    const dispose = preference.mount();
    await Promise.resolve();
    expect(disabled).toHaveBeenCalledOnce();
    dispose();
    tauri.invoke.mockResolvedValueOnce({ content: '{"desktop":{"logPanelEnabled":true}}' });
    const stop = preference.mount();
    stop();
    await Promise.resolve();
    expect(preference.enabled).toBe(false);
  });
});
