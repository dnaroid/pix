import type { SearchSourceId } from "./search-index-status";

export interface IndexResult {
  diagnostics?: readonly { sessionId: string; path: string; reason: string; line?: number; code?: string; entryId?: string; parentId?: string }[];
  source: SearchSourceId;
  complete: boolean;
  indexed?: number;
  total?: number;
  message?: string;
}
export interface IndexActionState {
  running: boolean;
  stopping?: boolean;
  result?: IndexResult;
  error?: string;
  cancelled?: boolean;
}
export type IndexActions = Partial<Record<SearchSourceId, IndexActionState>>;

/** Panel-owned explicit work; diagnostic refreshes never enter this path. */
export function createSearchIndexActions(options: {
  run(source: SearchSourceId, signal: AbortSignal): Promise<IndexResult>;
  onChange(state: IndexActions): void;
  onSettled(): void;
}) {
  let state: IndexActions = {};
  let closed = false;
  let generation = 0;
  const active = new Map<SearchSourceId, AbortController>();
  const publish = (source: SearchSourceId, value: IndexActionState) => {
    state = { ...state, [source]: value };
    options.onChange(state);
  };
  return {
    async start(source: SearchSourceId): Promise<void> {
      if (closed || active.has(source)) return;
      const controller = new AbortController();
      const request = generation;
      const current = () => !closed && request === generation;
      active.set(source, controller);
      publish(source, { running: true });
      try {
        const result = await options.run(source, controller.signal);
        controller.signal.throwIfAborted();
        if (result.source !== source || typeof result.complete !== "boolean") throw new Error("Invalid indexing result");
        if (current()) publish(source, { running: false, result });
      } catch {
        if (current()) publish(source, { running: false, cancelled: controller.signal.aborted, error: controller.signal.aborted
          ? "Indexing stopped. Saved batches are retained." : "Indexing unavailable. Try again; saved batches are retained." });
      } finally {
        // Deduplicate this source until its transport settles, even after abort.
        active.delete(source);
        if (!closed) options.onSettled();
      }
    },
    cancel(source: SearchSourceId) {
      const controller = active.get(source);
      if (!controller || controller.signal.aborted) return;
      controller.abort();
      if (!closed && state[source]?.running) publish(source, { ...state[source]!, stopping: true });
    },
    reset() {
      generation++;
      for (const controller of active.values()) controller.abort();
      state = {};
      if (!closed) options.onChange(state);
    },
    dispose() { closed = true; for (const controller of active.values()) controller.abort(); active.clear(); },
  };
}

export function indexActionLabel(action?: IndexActionState): string {
  if (action?.running) return "Stop";
  if (action?.cancelled || (action?.result && !action.result.complete)) return "Continue";
  return "Index";
}

export function indexOutcomeLabel(action?: IndexActionState): string | undefined {
  if (action?.cancelled) return "Stopped";
  if (action?.error) return "Failed";
  if (action?.result) return action.result.complete ? "Indexed" : "Incomplete";
  return undefined;
}

export function indexResultDetail(action?: IndexActionState): string | undefined {
  if (action?.stopping) return "Stopping this run; waiting for its transport to finish. Saved batches are retained.";
  if (action?.running) return "Indexing this source; closing the panel stops this manual run";
  if (action?.error) return action.error;
  const result = action?.result;
  if (!result) return undefined;
  const coverage = result.indexed !== undefined && result.total !== undefined ? `${result.indexed}/${result.total}. ` : "";
  return `Last run: ${coverage}${result.message ?? (result.complete ? "Indexing complete." : "Indexing incomplete; run again to continue.")}`;
}
