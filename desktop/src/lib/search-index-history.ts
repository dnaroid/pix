import type { SearchSourceId } from "./search-index-status";

export const SEARCH_INDEX_HISTORY_LIMIT = 200;
export interface SearchIndexEvent {
  id: number;
  time: number;
  workspace: string;
  source: SearchSourceId | "system";
  level: "info" | "success" | "warning" | "error";
  message: string;
}

/** One window-lifetime ring; no files, embedding text, credentials or raw errors. */
export function createSearchIndexHistory(now: () => number = Date.now) {
  let events: SearchIndexEvent[] = [];
  let sequence = 0;
  return {
    entries: (workspace: string) => events.filter(event => event.workspace === workspace),
    clear(workspace: string) {
      events = events.filter(event => event.workspace !== workspace);
    },
    append(workspace: string, source: SearchIndexEvent["source"], level: SearchIndexEvent["level"], message: string) {
      events = [...events, { id: ++sequence, time: now(), workspace, source, level, message: message.slice(0, 300) }]
        .slice(-SEARCH_INDEX_HISTORY_LIMIT);
    },
  };
}
export type SearchIndexHistory = ReturnType<typeof createSearchIndexHistory>;
