import { describe, expect, it } from "vitest";
import { emptySearchIndexView, type SearchIndexViewState } from "./search-index-controller";
import { searchIndexIndicatorReasons } from "./search-index-indicators";
import { sidebarIndicators } from "./sidebar-indicators";
import { sidebarIndicatorActionGroups } from "./sidebar-indicator-actions";
import activityBar from "../components/WorkspaceSidebarActivityBar.svelte?raw";

function stored(): SearchIndexViewState {
  return { actions: {}, history: [], snapshot: { reading: false, error: "", activity: null,
    consent: { configured: true, provider: "ollama", model: "m", vectorSize: 3, keyAvailable: true },
    stores: { stores: [
      { id: "code", state: "present", completedAt: "now", counts: { codeChunks: 100, vectors: 1 } },
      { id: "knowledge", state: "present", completedAt: "now", counts: { knowledgeChunks: 20, vectors: 1 } },
      { id: "settings", state: "present", counts: { settingsDocuments: 100, settingsVectors: 1 } },
      { id: "sessions", state: "present", counts: { sessionTitles: 500, sessionVectors: 1 } },
      { id: "tasks", state: "present", counts: { taskDocuments: 3, taskVectors: 1 } },
      { id: "commits", state: "present", counts: { commitDocuments: 99, commitVectors: 1 } },
    ] },
  } };
}
function indicator(searchIndexes: SearchIndexViewState) {
  return sidebarIndicators({ service: { unseenScriptFailureIds: [] }, taskStorageError: false,
    activeTaskId: null, searchIndexes }).search;
}

describe("search indexing sidebar reasons", () => {
  it("does not infer missing coverage from unknown status or retained vector counts", () => {
    expect(searchIndexIndicatorReasons()).toEqual([]);
    expect(indicator(emptySearchIndexView())).toBeUndefined();
    expect(indicator(stored())).toBeUndefined();
  });
  it("warns for absent local indexes even with semantics off", () => {
    const view = stored();
    view.snapshot.consent = { ...view.snapshot.consent!, configured: false };
    view.snapshot.stores = { stores: [{ id: "code", state: "absent", counts: {} }, { id: "knowledge", state: "absent", counts: {} }] };
    expect(indicator(view)).toMatchObject({ tone: "warning", reason: expect.stringContaining("Code, Knowledge") });
  });
  it("warns for missing vectors, not empty corpora or disabled semantics", () => {
    const view = stored();
    view.snapshot.stores = { stores: view.snapshot.stores!.stores.map(store => ["tasks", "sessions"].includes(store.id)
      ? { ...store, counts: { ...store.counts, taskDocuments: 0, taskVectors: 0, sessionVectors: 0 } } : store) };
    expect(indicator(view)?.reason).toBe("Search indexes need attention: Sessions");
    view.snapshot.consent = { ...view.snapshot.consent!, configured: false };
    expect(indicator(view)).toBeUndefined();
  });
  it("shows source-specific animated activity above pending work, but below errors", () => {
    const view = stored();
    view.actions.sessions = { running: false, result: { source: "sessions", complete: false } };
    view.snapshot.activity = { indexingSources: { tasks: true, settings: false, sessions: false } };
    expect(indicator(view)).toEqual({ tone: "info", animated: true, reason: "Indexing: Tasks" });
    expect(searchIndexIndicatorReasons(view).map(reason => reason.id)).toEqual(["search.indexing", "search.pending"]);
    view.actions.code = { running: false, error: "Failed" };
    expect(indicator(view)).toEqual({ tone: "error", reason: "Code: Failed" });
  });
  it("suppresses missing-index warnings only for confirmed empty sessions and Git history", () => {
    const view = stored();
    view.snapshot.stores = { commitsEmpty: true, stores: view.snapshot.stores!.stores.map(store => ["sessions", "commits"].includes(store.id)
      ? { ...store, counts: { ...store.counts, sessionVectors: 0, commitVectors: 0 } } : store) };
    view.snapshot.activity = { sessionsEmpty: true };
    expect(indicator(view)).toBeUndefined();
    view.snapshot.activity = { sessionsEmpty: false };
    expect(indicator(view)?.reason).toBe("Search indexes need attention: Sessions");
    view.snapshot.stores = { ...view.snapshot.stores, commitsEmpty: undefined };
    expect(indicator(view)?.reason).toBe("Search indexes need attention: Sessions, Git commits");
  });
  it("retains manual incomplete and stopped outcomes, clearing them on successful retry", () => {
    const view = stored();
    view.actions.code = { running: true };
    expect(indicator(view)).toMatchObject({ tone: "info", animated: true });
    view.actions.code = { running: false, error: "Stopped", cancelled: true };
    expect(indicator(view)).toMatchObject({ tone: "warning" });
    view.actions.code = { running: false, result: { source: "code", complete: true } };
    expect(indicator(view)).toBeUndefined();
  });
  it("reports read errors and incompatible caches without manufacturing activity", () => {
    const view = stored();
    view.snapshot.activity = { sourceErrors: { tasks: "Provider unavailable" } };
    expect(indicator(view)).toMatchObject({ tone: "error", reason: "Tasks: Provider unavailable" });
    view.snapshot.activity = null;
    view.snapshot.activityError = "Search activity could not be read";
    expect(indicator(view)).toMatchObject({ tone: "error" });
    view.snapshot.activityError = "";
    view.snapshot.stores = { stores: view.snapshot.stores!.stores.map(store => store.id === "sessions"
      ? { ...store, incompatibleSources: ["sessions"] } : store) };
    expect(indicator(view)).toMatchObject({ tone: "warning", reason: expect.stringContaining("Sessions") });
  });
  it("wires accessible dot and cause-specific navigation to the shared manager", () => {
    expect(activityBar).toContain('<SidebarIndicatorDot indicator={indicators.search} />');
    expect(activityBar).toContain('activityLabel("search", "Search index status")');
    expect(activityBar).toContain('onIndicatorContext(event, "search")');
    const view = stored();
    view.actions.code = { running: true };
    const groups = sidebarIndicatorActionGroups(searchIndexIndicatorReasons(view));
    expect(groups[0]?.actions).toEqual([{ id: "search.inspect", label: "Inspect search indexes", disabled: false }]);
  });
});
