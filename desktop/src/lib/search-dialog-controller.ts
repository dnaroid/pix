import type { SearchStatus } from "../../../acp/src/search/contract";
import type { SearchKind, UnifiedSearchResult } from "./universal-search";

export interface SearchDialogState {
  result: UnifiedSearchResult;
  busy: boolean;
  submitted: boolean;
  status?: SearchStatus;
  statusError?: string;
}
export const emptySearchDialogState = (): SearchDialogState => ({
  result: { results: [], idxAvailable: false, notices: [] }, busy: false, submitted: false,
});

async function cancellable<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("Search dialog request cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation(), cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Explicit submissions and independent status polling share only dialog lifetime. */
export class SearchDialogController {
  private state = emptySearchDialogState();
  private queryController?: AbortController;
  private statusController?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private generation = 0;

  constructor(
    private readonly search: (query: string, types: readonly SearchKind[], signal: AbortSignal, onUpdate: (result: UnifiedSearchResult) => void) => Promise<UnifiedSearchResult>,
    private readonly readStatus: ((signal: AbortSignal) => Promise<SearchStatus>) | undefined,
    private readonly publish: (state: SearchDialogState) => void,
    private readonly pollMs = 1500,
    initialState = emptySearchDialogState(),
  ) { this.state = initialState; }

  start(): void {
    if (this.disposed || this.statusController || this.timer) return;
    if (this.readStatus) void this.pollStatus();
  }

  private update(changes: Partial<SearchDialogState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...changes };
    this.publish(this.state);
  }

  invalidate(): void {
    this.generation++;
    this.queryController?.abort();
    this.queryController = undefined;
    this.update({ result: emptySearchDialogState().result, busy: false, submitted: false });
  }

  async submit(query: string, types: readonly SearchKind[]): Promise<void> {
    if (this.disposed) return;
    this.invalidate();
    if (!query.trim() || !types.length) return;
    const generation = this.generation;
    const controller = new AbortController();
    this.queryController = controller;
    this.update({ busy: true, submitted: true });
    let initialFinished = false;
    const publishResult = (result: UnifiedSearchResult) => {
      if (this.disposed || controller.signal.aborted || generation !== this.generation) return;
      this.update({ result });
      if (initialFinished && !result.pendingSources?.length && this.queryController === controller) this.queryController = undefined;
    };
    try {
      const result = await cancellable(controller.signal, () => this.search(query.trim(), [...types], controller.signal, publishResult));
      if (this.disposed || controller.signal.aborted || generation !== this.generation) return;
      initialFinished = true;
      this.update({ result, busy: false });
    } catch {
      if (this.disposed || controller.signal.aborted || generation !== this.generation) return;
      controller.abort();
      this.update({ result: { results: [], idxAvailable: false, notices: ["Search failed. Please try again."] }, busy: false });
    } finally {
      if (this.queryController === controller && !this.state.result.pendingSources?.length) this.queryController = undefined;
    }
  }

  private async pollStatus(): Promise<void> {
    if (this.disposed || !this.readStatus) return;
    const controller = new AbortController();
    this.statusController = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const status = await cancellable(controller.signal, () => this.readStatus!(controller.signal));
      if (!controller.signal.aborted) this.update({ status, statusError: undefined });
    } catch {
      if (!this.disposed) this.update({ statusError: "Index status unavailable. Retrying…" });
    } finally {
      clearTimeout(timeout);
      controller.abort();
      if (this.statusController === controller) this.statusController = undefined;
      if (!this.disposed) this.timer = setTimeout(() => { this.timer = undefined; void this.pollStatus(); }, this.pollMs);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.queryController?.abort();
    this.statusController?.abort();
    if (this.timer) clearTimeout(this.timer);
  }
}

export function searchStatusLabel(status: SearchStatus | undefined): string {
  if (!status) return "Search status unavailable";
  if (status.tasksSemanticEnabled && status.keyAvailable) {
    return "Semantic task search enabled · task titles/descriptions require separate consent";
  }
  if (status.keyAvailable && status.enabled && status.sessionTitlesEnabled) {
    return "Semantic settings + session-title search enabled · history stays local";
  }
  if (status.keyAvailable && status.sessionTitlesEnabled) {
    return "Semantic session-title search enabled · conversation history stays local";
  }
  if (status.enabled && status.keyAvailable) {
    return "Semantic settings search enabled · session titles require separate opt-in";
  }
  if (status.enabled || status.sessionTitlesEnabled || status.tasksSemanticEnabled) {
    return "Semantic search enabled · OpenRouter key unavailable; local search remains available";
  }
  return "Local search · semantic search is opt-in";
}
