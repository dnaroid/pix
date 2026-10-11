import { createSearchIndexActions, type IndexActions } from "./search-index-actions";
import { monitorSearchIndexes, type SearchIndexSnapshot } from "./search-index-monitor";
import { createSearchIndexHistory, type SearchIndexEvent, type SearchIndexHistory } from "./search-index-history";
import { observeSearchIndexEvents } from "./search-index-events";
import type { SearchSyncEvent } from "./search-index-sync";

export interface SearchIndexViewState {
  snapshot: SearchIndexSnapshot;
  actions: IndexActions;
  history: SearchIndexEvent[];
}

export function emptySearchIndexView(): SearchIndexViewState {
  return { snapshot: { stores: null, consent: null, activity: null, reading: false, error: "" }, actions: {}, history: [] };
}

/** One workspace-owned diagnostic lane shared by the panel and Activity Bar. */
export function createSearchIndexController(options: Omit<Parameters<typeof monitorSearchIndexes>[0], "onChange" | "isIndexing"> & {
  run: Parameters<typeof createSearchIndexActions>[0]["run"];
  onChange(state: SearchIndexViewState): void;
  workspace?: string;
  history?: SearchIndexHistory;
}) {
  let state = emptySearchIndexView();
  let disposed = false;
  const history = options.history ?? createSearchIndexHistory();
  const workspace = options.workspace ?? "";
  const events = observeSearchIndexEvents(history, workspace);
  const publish = (change: Partial<SearchIndexViewState>) => {
    if (disposed) return;
    state = { ...state, ...change, history: history.entries(workspace) };
    options.onChange(state);
  };
  const indexing = createSearchIndexActions({
    run: options.run,
    onChange: actions => { events.actions(actions); publish({ actions }); },
    onSettled: () => { void monitor.refresh(true); },
  });
  const monitor = monitorSearchIndexes({
    ...options,
    onChange: snapshot => { events.snapshot(snapshot); publish({ snapshot }); },
    isIndexing: () => Object.values(state.actions).some(action => action?.running),
  });
  return {
    syncEvent: (event: SearchSyncEvent) => {
      if (disposed) return;
      const messages = { started: "Settings/task catalogue sync requested", completed: "Catalogue registered; background reconciliation scheduled if needed", failed: "Catalogue sync failed", cancelled: "Catalogue sync cancelled" };
      events.add("system", event === "failed" ? "error" : "info", messages[event]);
      publish({});
    },
    refresh: () => { void monitor.refresh(); },
    start: (source: Parameters<typeof indexing.start>[0]) => { void indexing.start(source); void monitor.refresh(true); },
    cancel: indexing.cancel,
    // Closing the panel still stops manual work, but does not erase its outcome
    // or the independent background activity used by the Activity Bar.
    closePanel: () => {
      for (const source of Object.keys(state.actions) as Array<keyof IndexActions>) indexing.cancel(source);
    },
    configChanged: () => {
      if (disposed) return;
      events.add("system", "info", "Configuration change received");
      indexing.reset();
      void monitor.refresh(true);
    },
    dispose: () => {
      events.actions({});
      disposed = true; monitor.dispose(); indexing.dispose();
    },
  };
}

export type SearchIndexController = ReturnType<typeof createSearchIndexController>;
