import { createSearchIndexActions, type IndexActions } from "./search-index-actions";
import { monitorSearchIndexes, type SearchIndexSnapshot } from "./search-index-monitor";
import type { SourcePolicy, SearchSource } from "./search-source-selection";

export interface SearchIndexViewState {
  snapshot: SearchIndexSnapshot;
  actions: IndexActions;
  savingSource?: SearchSource;
}

export function emptySearchIndexView(): SearchIndexViewState {
  return { snapshot: { stores: null, consent: null, activity: null, reading: false, error: "" }, actions: {} };
}

/** One workspace-owned diagnostic lane shared by the panel and Activity Bar. */
export function createSearchIndexController(options: Omit<Parameters<typeof monitorSearchIndexes>[0], "onChange" | "isIndexing"> & {
  run: Parameters<typeof createSearchIndexActions>[0]["run"];
  setSource?: (source: SearchSource, enabled: boolean, signal: AbortSignal) => Promise<SourcePolicy>;
  onChange(state: SearchIndexViewState): void;
  workspace?: string;
}) {
  let state = emptySearchIndexView();
  let disposed = false;
  const selectionOwner = new AbortController();
  const publish = (change: Partial<SearchIndexViewState>) => {
    if (disposed) return;
    state = { ...state, ...change };
    options.onChange(state);
  };
  const indexing = createSearchIndexActions({
    run: options.run,
    onChange: actions => publish({ actions }),
    onSettled: () => { void monitor.refresh(true); },
  });
  const monitor = monitorSearchIndexes({
    ...options,
    onChange: snapshot => publish({ snapshot }),
    isIndexing: () => Object.values(state.actions).some(action => action?.running),
  });
  return {
    refresh: () => { void monitor.refresh(); },
    start: (source: Parameters<typeof indexing.start>[0]) => {
      if (options.readSelection && !state.snapshot.selection?.enabled[source]) return;
      void indexing.start(source); void monitor.refresh(true);
    },
    setSource: async (source: SearchSource, enabled: boolean) => {
      if (disposed || state.savingSource || !options.setSource) return;
      indexing.cancel(source);
      publish({ savingSource: source });
      try {
        const selection = await options.setSource(source, enabled, selectionOwner.signal);
        publish({ snapshot: { ...state.snapshot, selection, selectionError: selection.error ?? "" } });
        await monitor.refresh(true);
      } catch (error) {
        if (!disposed) publish({ snapshot: { ...state.snapshot, selectionError: error instanceof Error ? error.message : "Could not save source selection" } });
      } finally { publish({ savingSource: undefined }); }
    },
    cancel: indexing.cancel,
    // Closing the panel still stops manual work, but does not erase its outcome
    // or the independent background activity used by the Activity Bar.
    closePanel: () => {
      for (const source of Object.keys(state.actions) as Array<keyof IndexActions>) indexing.cancel(source);
    },
    configChanged: () => {
      if (disposed) return;
      indexing.reset();
      void monitor.refresh(true);
    },
    dispose: () => {
      disposed = true; selectionOwner.abort(); monitor.dispose(); indexing.dispose();
    },
  };
}

export type SearchIndexController = ReturnType<typeof createSearchIndexController>;
