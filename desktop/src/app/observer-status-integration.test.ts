import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import type { HeadsUpSnapshot } from "../lib/heads-up";
import { createHeadsUpStore } from "./heads-up.svelte";
import { createDesktopStatusBarViewModel } from "./desktop-status-bar-view-model.svelte";

function snapshot(instanceId: string): HeadsUpSnapshot {
  return { version: 1, instanceId, revision: 1, enabled: false, model: "provider/model", phase: "off", checks: 0, inputTokens: 0, outputTokens: 0, notice: null };
}

describe("Observer statusbar ownership", () => {
  afterEach(() => vi.restoreAllMocks());
  it("requests a missing snapshot only for a registered command, never an unknown slash prompt", async () => {
    let available = false;
    const prompt = vi.fn(async () => {});
    const store = createHeadsUpStore({ client: () => ({ prompt }) as unknown as AcpClient, runtimeReady: () => true, commandAvailable: () => available, reportError: vi.fn() });
    await store.requestSnapshot("a"); expect(prompt).not.toHaveBeenCalled();
    available = true;
    await store.requestSnapshot("a");
    expect(prompt).toHaveBeenCalledWith("a", [{ type: "text", text: "/heads-up snapshot" }]);
    expect(store.state("a")).toBeUndefined();
    store.reset();
  });
  it("stale statusbar actions cannot toggle another session or replacement runtime", async () => {
    let id: string | null = "a";
    let ready = true;
    let draft = false;
    const prompt = vi.fn(async () => {});
    const store = createHeadsUpStore({ client: () => ({ prompt }) as unknown as AcpClient, runtimeReady: () => ready, reportError: vi.fn() });
    store.handleSessionState({ sessionId: "a", channel: "heads-up", data: snapshot("r1") });
    store.handleSessionState({ sessionId: "b", channel: "heads-up", data: snapshot("r2") });
    const view = createDesktopStatusBarViewModel({
      status: () => "ready", displayedConfigOptions: () => [], changingConfig: () => null,
      promptRunning: () => false, canUseSession: () => true, sessionHistoryLoading: () => false,
      draftSessionTabActive: () => draft, draftConfigAvailable: () => false, activeSessionRuntimeReady: () => ready,
      activeSessionId: () => id, sessionActivity: () => ({}), sessionSubagentSnapshot: () => undefined, sessionTodoSnapshot: () => undefined,
      sessionNeedsInput: () => false, canClearTodos: () => false,
      runtime: { statuses: new Map(), sessionUsageBySession: new Map(), sessionUsageRefreshing: new Set(), sessionUsageFailed: new Set(), claudeLimitsRefreshing: new Set(), claudeLimitsFailed: new Set() },
      modelConfig: { pickerOpen: false }, sessionCoordinator: {},
      quotaWait: { indicator: () => undefined, nowMs: 0 }, headsUp: store, openObserverSettings: vi.fn(),
    } as unknown as Parameters<typeof createDesktopStatusBarViewModel>[0]);
    const first = view.props.observer!;
    expect(first.snapshot?.instanceId).toBe("r1");
    first.onToggle(); await Promise.resolve();
    expect(prompt).toHaveBeenCalledWith("a", [{ type: "text", text: "/heads-up on" }]);
    prompt.mockClear(); id = "b";
    first.onToggle(); first.onCheck(); first.onRequestSnapshot();
    expect(prompt).not.toHaveBeenCalled();
    expect(view.props.observer?.snapshot?.instanceId).toBe("r2");
    id = "a";
    store.handleSessionState({ sessionId: "a", channel: "heads-up", data: snapshot("r3") });
    first.onToggle(); expect(prompt).not.toHaveBeenCalled();
    ready = false; expect(view.props.observer?.runtimeReady).toBe(false);
    draft = true; expect(view.props.observer?.sessionId).toBeNull();
    store.reset();
  });
});
