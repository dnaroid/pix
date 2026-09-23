import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSessionTabIds, SESSION_TABS_STORAGE_KEY } from "../lib/session-tabs";
import { createSessionTabsState } from "./session-tabs-state.svelte";

describe("session tabs state persistence", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
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
    expect(parseSessionTabIds(values.get(SESSION_TABS_STORAGE_KEY) ?? null).get("/project"))
      .toEqual(["open", "desktop-only"]);

    tabs.markClosed("open");
    expect(parseSessionTabIds(values.get(SESSION_TABS_STORAGE_KEY) ?? null).get("/project"))
      .toEqual(["desktop-only"]);
  });

  it("persists an explicit empty list so stale TUI tabs stay closed after restart", () => {
    const tabs = createSessionTabsState();
    tabs.setSessionTabIds(new Map([["/project", []]]));
    tabs.mergeRestored("/project", ["stale"], ["stale"]);

    expect(tabs.restoredIds).toEqual([]);
    expect(tabs.closedIds).toEqual(["stale"]);
    expect(parseSessionTabIds(values.get(SESSION_TABS_STORAGE_KEY) ?? null).get("/project"))
      .toEqual([]);
  });

  it("treats a missing Desktop snapshot as empty instead of falling back to TUI tabs", () => {
    const tabs = createSessionTabsState();
    tabs.setSessionTabIds(new Map());
    tabs.mergeRestored("/project", ["stale-a", "stale-b"], ["stale-a", "stale-b"]);

    expect(tabs.restoredIds).toEqual([]);
    expect(tabs.closedIds).toEqual(["stale-a", "stale-b"]);
    expect(parseSessionTabIds(values.get(SESSION_TABS_STORAGE_KEY) ?? null).get("/project"))
      .toEqual([]);
  });
});
