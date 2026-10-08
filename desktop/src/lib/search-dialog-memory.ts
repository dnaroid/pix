import { emptySearchDialogState, type SearchDialogState } from "./search-dialog-controller";
import { SEARCH_KINDS, type SearchKind } from "./universal-search";
import { pendingSearchNotice } from "./search-source-deadline";

export interface SearchDialogDraft {
  query: string;
  types: SearchKind[];
  view: SearchDialogState;
  active: number;
}

function emptyDraft(): SearchDialogDraft {
  return { query: "", types: [...SEARCH_KINDS], view: emptySearchDialogState(), active: -1 };
}

/** One window-owned context; nothing is persisted to disk or shared across clients. */
export class SearchDialogMemory {
  private workspace?: string;
  private connection: unknown;
  private draft = emptyDraft();

  resetFor(workspace: string, connection: unknown): void {
    if (this.workspace === workspace && this.connection === connection) return;
    this.workspace = workspace;
    this.connection = connection;
    this.draft = emptyDraft();
  }

  restore(workspace: string, connection: unknown): SearchDialogDraft {
    this.resetFor(workspace, connection);
    return structuredClone(this.draft);
  }

  save(workspace: string, connection: unknown, draft: SearchDialogDraft): void {
    if (this.workspace !== workspace || this.connection !== connection) return;
    this.draft = structuredClone(draft);
    const { view } = this.draft;
    if (view.busy || view.result.pendingSources?.length) {
      const pendingNotices = new Set(view.result.pendingSources?.map(pendingSearchNotice));
      view.result.notices = view.result.notices.filter(notice => !pendingNotices.has(notice));
      delete view.result.pendingSources;
      if (view.result.results.length) view.result.notices.push("Some sources were still searching when this dialog closed. Press Search to search again.");
      else view.submitted = false;
    }
    this.draft.view.busy = false;
  }
}
