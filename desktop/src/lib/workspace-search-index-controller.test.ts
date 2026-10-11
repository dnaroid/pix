import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { indexNativeRepository } from "./native-repository-search";
import { createWorkspaceSearchIndexController } from "./workspace-search-index-controller";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./native-repository-search", () => ({ indexNativeRepository: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("workspace search indicator transport", () => {
  it("reads diagnostics in the selected workspace, routes explicit indexing, and releases config listeners", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", new EventTarget());
    vi.mocked(invoke).mockImplementation(async command => (command === "search_index_status" ? { stores: [] }
      : { configured: true, provider: "ollama", model: "m", vectorSize: 3, keyAvailable: true }) as never);
    vi.mocked(indexNativeRepository).mockResolvedValue({ source: "code", complete: true });
    const client = { searchConfig: vi.fn().mockResolvedValue({}), searchIndex: vi.fn().mockResolvedValue({ source: "settings", complete: true }) };
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const onChange = vi.fn();
    const controller = createWorkspaceSearchIndexController("/selected", client, onChange);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledWith("search_index_status", { workspace: "/selected" });
    expect(client.searchConfig).toHaveBeenCalledWith("/selected", {}, expect.any(AbortSignal));
    expect(client.searchIndex).not.toHaveBeenCalled();
    expect(indexNativeRepository).not.toHaveBeenCalled();
    controller.start("settings");
    await vi.advanceTimersByTimeAsync(0);
    expect(client.searchIndex).toHaveBeenCalledWith({ cwd: "/selected", source: "settings", settings: expect.any(Array) }, expect.any(AbortSignal));
    controller.start("code");
    await vi.advanceTimersByTimeAsync(0);
    expect(indexNativeRepository).toHaveBeenCalledWith(invoke, "/selected", "code", expect.any(AbortSignal));
    expect(add).toHaveBeenCalledWith("pix-semantic-config-changed", controller.configChanged);
    window.dispatchEvent(new Event("pix-semantic-config-changed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange.mock.lastCall?.[0].actions).toEqual({});
    controller.dispose();
    expect(remove).toHaveBeenCalledWith("pix-semantic-config-changed", controller.configChanged);
    const reads = vi.mocked(invoke).mock.calls.length;
    const changes = onChange.mock.calls.length;
    window.dispatchEvent(new Event("pix-semantic-config-changed"));
    await vi.advanceTimersByTimeAsync(60000);
    expect(invoke).toHaveBeenCalledTimes(reads);
    expect(onChange).toHaveBeenCalledTimes(changes);
  });
});
