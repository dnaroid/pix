import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSessionTabIds } from "../lib/session-tabs";
import { windowLayoutKey } from "../lib/window-layout-storage";
import { createSessionTabsState } from "./session-tabs-state.svelte";
import { restoreProjectWorkspace } from "./project-workspace.svelte";

const nativeWindow = vi.hoisted(() => ({ label: "main" }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => nativeWindow }));

describe("session tabs state persistence", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    nativeWindow.label = "main";
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps the Desktop snapshot authoritative and persists the visible set after tab mutations", () => {
    const tabs = createSessionTabsState();
    tabs.setSessionTabIds(new Map([["/project", ["open"]]]));

    tabs.mergeRestored("/project", ["closed", "open"], ["closed", "open", "desktop-only"]);
    expect(tabs.restoredIds).toEqual(["open"]);
    expect(tabs.closedIds).toEqual(["closed"]);

    tabs.show("desktop-only");
    expect(parseSessionTabIds(values.get(windowLayoutKey("sessionTabs")) ?? null).get("/project"))
      .toEqual(["open", "desktop-only"]);

    tabs.markClosed("open");
    expect(parseSessionTabIds(values.get(windowLayoutKey("sessionTabs")) ?? null).get("/project"))
      .toEqual(["desktop-only"]);
  });

  it("persists an explicit empty list so stale TUI tabs stay closed after restart", () => {
    const tabs = createSessionTabsState();
    tabs.setSessionTabIds(new Map([["/project", []]]));
    tabs.mergeRestored("/project", ["stale"], ["stale"]);

    expect(tabs.restoredIds).toEqual([]);
    expect(tabs.closedIds).toEqual(["stale"]);
    expect(parseSessionTabIds(values.get(windowLayoutKey("sessionTabs")) ?? null).get("/project"))
      .toEqual([]);
  });

  it("treats a missing Desktop snapshot as empty instead of falling back to TUI tabs", () => {
    const tabs = createSessionTabsState();
    tabs.setSessionTabIds(new Map());
    tabs.mergeRestored("/project", ["stale-a", "stale-b"], ["stale-a", "stale-b"]);

    expect(tabs.restoredIds).toEqual([]);
    expect(tabs.closedIds).toEqual(["stale-a", "stale-b"]);
    expect(parseSessionTabIds(values.get(windowLayoutKey("sessionTabs")) ?? null).get("/project"))
      .toEqual([]);
  });

  it("restores each window's ordered tabs and active session without last-writer collisions", () => {
    const first = createSessionTabsState();
    first.mergeRestored("/project", null, ["a", "b", "c"]);
    first.show("b");
    first.show("a");
    first.rememberActive("/project", "a");

    nativeWindow.label = "project/second";
    const second = createSessionTabsState();
    second.mergeRestored("/project", null, ["a", "b", "c"]);
    second.show("c");
    second.rememberActive("/project", "c");

    // Mutate the first controller while the mocked current window is second:
    // storage ownership must have been captured, not resolved on every write.
    first.markClosed("b");
    first.show("b");
    first.rememberActive("/project", "a");
    const restore = () => restoreProjectWorkspace("http://localhost/?workspace=%2Fproject", localStorage);
    const secondRestored = restore();
    expect(secondRestored.sessionTabIds.get("/project")).toEqual(["c"]);
    expect(secondRestored.activeSessionIds.get("/project")).toBe("c");

    nativeWindow.label = "main";
    const firstRestored = restore();
    expect(firstRestored.sessionTabIds.get("/project")).toEqual(["a", "b"]);
    expect(firstRestored.activeSessionIds.get("/project")).toBe("a");

    const restarted = createSessionTabsState();
    restarted.setSessionTabIds(firstRestored.sessionTabIds);
    restarted.setActiveSessionIds(firstRestored.activeSessionIds);
    restarted.mergeRestored("/project", ["c"], ["a", "b", "c"]);
    expect(restarted.restoredIds).toEqual(["a", "b"]);
    expect(restarted.closedIds).toEqual(["c"]);
    expect(restarted.activeForProject("/project")).toBe("a");

    nativeWindow.label = "project/second";
    second.markClosed("c");
    second.forgetActive("/project");
    expect(restore().sessionTabIds.get("/project")).toEqual([]);
    expect(restore().activeSessionIds.has("/project")).toBe(false);
    nativeWindow.label = "main";
    expect(restore().activeSessionIds.get("/project")).toBe("a");
  });

  it("retains separate project snapshots within one window", () => {
    const tabs = createSessionTabsState();
    tabs.mergeRestored("/one", null, ["a"]);
    tabs.show("a");
    tabs.rememberActive("/one", "a");
    tabs.resetTabs();
    tabs.mergeRestored("/two", null, ["b"]);
    tabs.show("b");
    tabs.rememberActive("/two", "b");
    const restored = restoreProjectWorkspace("http://localhost/", localStorage);
    expect([...restored.sessionTabIds]).toEqual([["/one", ["a"]], ["/two", ["b"]]]);
    expect([...restored.activeSessionIds]).toEqual([["/one", "a"], ["/two", "b"]]);
  });

  it("does not import ambiguous shared snapshots into a new window", () => {
    values.set("pix.desktop.sessionTabs", JSON.stringify({ "/project": ["wrong"] }));
    values.set("pix.desktop.activeSessions", JSON.stringify({ "/project": "wrong" }));
    const restored = restoreProjectWorkspace("http://localhost/?workspace=%2Fproject", localStorage);
    expect(restored.sessionTabIds.size).toBe(0);
    expect(restored.activeSessionIds.size).toBe(0);
  });
});
