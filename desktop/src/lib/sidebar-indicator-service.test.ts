import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarIndicatorService } from "./sidebar-indicator-service";
import type { SidebarIndicatorServiceState, WorkspaceSidebarIndicatorPoll } from "./sidebar-indicator-types";
import type { IdxOverview } from "./idx";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => resolve = done);
  return { promise, resolve };
}
const poll: WorkspaceSidebarIndicatorPoll = {
  project: {}, git: { available: true, dirty: false, conflicted: false, detached: false, ahead: 0, behind: 0 },
  registry: { stable: true, localChanges: false }, scripts: { runningIds: [], failedIds: [] },
  idx: { runningIds: [], failedIds: [] }, settings: { errors: [] }, checkedAtMs: 1,
};
const overview: IdxOverview = { available: true, initialized: true, rawStatus: "", errors: [] };
const services: SidebarIndicatorService[] = [];
let windowEvents: EventTarget;
let documentEvents: EventTarget;
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);
function service(onChange = vi.fn(), ci = vi.fn()) {
  const result = new SidebarIndicatorService("main", onChange, ci);
  services.push(result);
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  windowEvents = new EventTarget();
  documentEvents = new EventTarget();
  vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener: windowEvents.addEventListener.bind(windowEvents), removeEventListener: windowEvents.removeEventListener.bind(windowEvents) });
  vi.stubGlobal("document", { visibilityState: "visible", hasFocus: () => true, addEventListener: documentEvents.addEventListener.bind(documentEvents), removeEventListener: documentEvents.removeEventListener.bind(documentEvents) });
  invoke.mockReset().mockImplementation((command: string) => Promise.resolve(command === "idx_overview" ? overview : command === "workspace_git_remote_update_probe" ? { hasUpdates: false, checkedAtMs: 1 } : poll));
  listen.mockReset().mockResolvedValue(vi.fn());
});
afterEach(() => {
  services.splice(0).forEach((value) => value.destroy());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sidebar polling lifecycle", () => {
  it("hands local IDX busy ownership to a fresh poll even after panel teardown", async () => {
    const old = deferred<WorkspaceSidebarIndicatorPoll>();
    const fresh = deferred<WorkspaceSidebarIndicatorPoll>();
    let count = 0;
    invoke.mockImplementation((command: string) => command === "workspace_sidebar_indicator_poll"
      ? (++count === 1 ? old.promise : count === 2 ? fresh.promise : Promise.resolve(poll))
      : Promise.resolve(command === "idx_overview" ? overview : { hasUpdates: false }));
    const updates = vi.fn<(state: SidebarIndicatorServiceState) => void>();
    const value = service(updates);
    value.start("/one");
    value.setIdxOperationRunning("/one", true);
    expect(updates.mock.lastCall?.[0].idxOperationHandoffPending).toBe(true);
    // No completion notification is sent when the owning panel unmounts.
    old.resolve(poll);
    await flush();
    expect(updates.mock.lastCall?.[0].idxOperationHandoffPending).toBe(true);
    fresh.resolve({ ...poll, idx: { runningIds: ["maintenance"], failedIds: [] } });
    await flush();
    expect(updates.mock.lastCall?.[0].idxOperationHandoffPending).toBe(false);
    expect(updates.mock.lastCall?.[0].poll?.idx.runningIds).toEqual(["maintenance"]);
    value.invalidateFast();
    await flush();
    expect(updates.mock.lastCall?.[0].poll?.idx.runningIds).toEqual([]);
  });

  it("retains IDX handoff on polling failure and rejects old-workspace notifications", async () => {
    const updates = vi.fn<(state: SidebarIndicatorServiceState) => void>();
    const value = service(updates);
    value.start("/one"); await flush();
    invoke.mockRejectedValue(new Error("offline"));
    value.setIdxOperationRunning("/one", true);
    await flush();
    expect(updates.mock.lastCall?.[0].idxOperationHandoffPending).toBe(true);
    value.setWorkspace("/two");
    value.setIdxOperationRunning("/one", true);
    await flush();
    expect(updates.mock.lastCall?.[0].idxOperationHandoffPending).not.toBe(true);
  });

  it("keeps IDX handoff through a resolved section error until an authoritative poll", async () => {
    const updates = vi.fn<(state: SidebarIndicatorServiceState) => void>();
    const value = service(updates);
    value.start("/one"); await flush();
    invoke.mockImplementation((command: string) => Promise.resolve(command === "workspace_sidebar_indicator_poll"
      ? { ...poll, idx: { runningIds: [], failedIds: [], error: "operation state unavailable" } }
      : command === "idx_overview" ? overview : { hasUpdates: false }));
    value.setIdxOperationRunning("/one", true);
    await flush();
    expect(updates.mock.lastCall?.[0].idxOperationHandoffPending).toBe(true);
    expect(updates.mock.lastCall?.[0].poll?.idx.error).toBe("operation state unavailable");
    invoke.mockImplementation((command: string) => Promise.resolve(command === "workspace_sidebar_indicator_poll"
      ? poll : command === "idx_overview" ? overview : { hasUpdates: false }));
    value.invalidateFast(); await flush();
    expect(updates.mock.lastCall?.[0].idxOperationHandoffPending).toBe(false);
  });

  it("coalesces a slow fast poll and rejects stale workspace results", async () => {
    const first = deferred<WorkspaceSidebarIndicatorPoll>();
    let count = 0;
    invoke.mockImplementation((command: string) => command === "workspace_sidebar_indicator_poll" ? (++count === 1 ? first.promise : Promise.resolve(poll)) : Promise.resolve(command === "idx_overview" ? overview : { hasUpdates: false }));
    const updates = vi.fn<(state: SidebarIndicatorServiceState) => void>();
    const value = service(updates);
    value.start("/one");
    value.invalidateFast(); value.invalidateFast();
    value.setWorkspace("/two");
    expect(calls("workspace_sidebar_indicator_poll")).toHaveLength(1);
    first.resolve({ ...poll, project: { error: "stale" } });
    await flush();
    expect(calls("workspace_sidebar_indicator_poll")).toHaveLength(2);
    expect(calls("workspace_sidebar_indicator_poll")[1]?.[1]?.workspace).toBe("/two");
    expect(updates.mock.calls.some(([state]) => state.poll?.project.error === "stale")).toBe(false);
  });

  it("unsubscribes late listeners and never publishes or schedules after destroy", async () => {
    const subscriptions = Array.from({ length: 4 }, () => deferred<() => void>());
    const stops = subscriptions.map(() => vi.fn());
    let index = 0;
    listen.mockImplementation(() => subscriptions[index++]!.promise);
    const pending = deferred<WorkspaceSidebarIndicatorPoll>();
    invoke.mockImplementation(() => pending.promise);
    const updates = vi.fn();
    const value = service(updates);
    value.start("/one");
    value.destroy();
    const published = updates.mock.calls.length;
    subscriptions.forEach((subscription, i) => subscription.resolve(stops[i]!));
    pending.resolve(poll);
    await flush();
    value.setWorkspace("/two"); value.setViewedTab("scripts");
    windowEvents.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
    expect(updates).toHaveBeenCalledTimes(published);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps sparse CI/remote/IDX cadence separate from fast work and refocus storms", async () => {
    const ci = vi.fn();
    const value = service(vi.fn(), ci);
    value.start("/one"); await flush();
    for (let i = 0; i < 10; i += 1) windowEvents.dispatchEvent(new Event("focus"));
    await flush();
    expect(ci).toHaveBeenCalledTimes(1);
    expect(calls("idx_overview")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ci).toHaveBeenCalledTimes(2);
    expect(calls("workspace_sidebar_indicator_poll").length).toBeGreaterThan(10);
    expect(calls("workspace_git_remote_update_probe")).toHaveLength(2);
    expect(calls("idx_overview")).toHaveLength(2);
  });

  it("reuses mounted IDX overview and acknowledges only viewed runtime failures", async () => {
    invoke.mockImplementation((command: string) => Promise.resolve(command === "workspace_sidebar_indicator_poll" ? { ...poll, scripts: { runningIds: [], failedIds: ["s"] }, idx: { runningIds: [], failedIds: ["i"] } } : { hasUpdates: false }));
    const updates = vi.fn<(state: SidebarIndicatorServiceState) => void>();
    const value = service(updates);
    value.setViewedTab("idx"); value.start("/one"); await flush();
    value.setIdxOverview("/one", overview);
    expect(calls("idx_overview")).toHaveLength(0);
    expect(updates.mock.lastCall?.[0].unseenIdxFailureIds).toEqual([]);
    expect(updates.mock.lastCall?.[0].unseenScriptFailureIds).toEqual(["s"]);
    value.setViewedTab("scripts"); await flush();
    expect(updates.mock.lastCall?.[0].unseenScriptFailureIds).toEqual([]);
    expect(calls("idx_overview")).toHaveLength(1);
  });
});
