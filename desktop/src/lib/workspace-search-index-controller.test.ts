import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { indexNativeRepository, requestNative } from "./native-repository-search";
import { createWorkspaceSearchIndexController } from "./workspace-search-index-controller";
import { readSearchSourceSelection } from "./search-source-selection";
import type { AcpClient } from "./acp-client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./native-repository-search", () => ({ indexNativeRepository: vi.fn(), requestNative: vi.fn() }));
vi.mock("./search-source-selection", () => ({
  SEARCH_SOURCE_SELECTION_CHANGED: "pix-search-sources-changed",
  readSearchSourceSelection: vi.fn(async () => ({ enabled: { settings: true, code: true } })),
  setSearchSourceSelection: vi.fn(),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("workspace search indicator transport", () => {
  it.each([false, true])("keeps native freshness available when ACP reconnects: %s", async reconnecting => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("crypto", { subtle: { digest: async () => new Uint8Array(32).buffer } });
    vi.mocked(invoke).mockResolvedValue({ stores: [] });
    vi.mocked(requestNative).mockResolvedValue({ observations: {}, runs: {} });
    const sessionSnapshot = "b".repeat(64);
    const client = {
      searchConfig: vi.fn<AcpClient["searchConfig"]>(async (_workspace, options) => {
        const status = { enabled: false, keyAvailable: false, indexing: false };
        if (options?.includeSessionSnapshot) {
          if (reconnecting) throw new Error("ACP reconnecting");
          return { ...status, sessionSnapshot };
        }
        return status;
      }),
      searchIndex: vi.fn(),
    };
    const controller = createWorkspaceSearchIndexController("/selected", client, vi.fn());
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(client.searchConfig).toHaveBeenCalledWith("/selected", { includeSessionSnapshot: true }, expect.any(AbortSignal));
      const call = vi.mocked(requestNative).mock.calls.find(([, , request]) => (request as Record<string, unknown>).operation === "snapshot-probe");
      expect(call).toBeDefined();
      expect((call![2] as Record<string, unknown>).sessionSnapshot).toBe(reconnecting ? undefined : sessionSnapshot);
      expect(client.searchIndex).not.toHaveBeenCalled();
    } finally { controller.dispose(); }
  });
  it("reads diagnostics in the selected workspace, routes explicit indexing, and releases config listeners", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", new EventTarget());
    vi.mocked(invoke).mockImplementation(async command => (command === "search_index_status" ? { stores: [] }
      : { configured: true, provider: "ollama", model: "m", vectorSize: 3, keyAvailable: true }) as never);
    vi.mocked(indexNativeRepository).mockResolvedValue({ source: "code", complete: true });
    vi.mocked(requestNative).mockImplementation(async (_invoke, _workspace, request) => {
      const payload = request as Record<string, unknown>;
      return (payload.operation === "snapshot-probe" ? { observations: {}, runs: {} }
        : { accepted: true, token: "test-owner", result: payload.result }) as never;
    });
    const client = { searchConfig: vi.fn().mockResolvedValue({}), searchIndex: vi.fn().mockResolvedValue({ source: "settings", complete: true }) };
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const onChange = vi.fn();
    const controller = createWorkspaceSearchIndexController("/selected", client, onChange);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledWith("search_index_status", { workspace: "/selected" });
    expect(client.searchConfig).toHaveBeenCalledWith("/selected", { includeSourceStatus: true }, expect.any(AbortSignal));
    expect(client.searchIndex).not.toHaveBeenCalled();
    expect(indexNativeRepository).not.toHaveBeenCalled();
    controller.start("settings");
    await vi.advanceTimersByTimeAsync(0);
    expect(client.searchIndex).toHaveBeenCalledWith({ cwd: "/selected", source: "settings", settings: expect.any(Array) }, expect.any(AbortSignal));
    controller.start("code");
    await vi.advanceTimersByTimeAsync(0);
    expect(indexNativeRepository).toHaveBeenCalledWith(invoke, "/selected", "code", expect.any(AbortSignal));
    expect(requestNative).toHaveBeenCalledWith(invoke, "/selected", expect.objectContaining({ operation: "index-control", action: "finish", source: "code", token: "test-owner" }), expect.any(AbortSignal));
    expect(add).toHaveBeenCalledWith("pix-semantic-config-changed", controller.configChanged);
    window.dispatchEvent(new Event("pix-semantic-config-changed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange.mock.lastCall?.[0].actions).toEqual({});
    const selections = vi.mocked(readSearchSourceSelection).mock.calls.length;
    const selectionEvent = (global: boolean) => Object.assign(new Event("pix-search-sources-changed"), { detail: { workspace: "/other", global } });
    window.dispatchEvent(selectionEvent(false));
    await vi.advanceTimersByTimeAsync(0);
    expect(readSearchSourceSelection).toHaveBeenCalledTimes(selections);
    window.dispatchEvent(selectionEvent(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(readSearchSourceSelection).mock.calls.length).toBeGreaterThan(selections);
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
