import { tick } from "svelte";
import type { SessionTodoTask } from "../lib/session-todos";
import { activityGroupIdFor, locateSessionStepStart } from "../lib/session-step-location";
import type { TranscriptState } from "../lib/transcript";

/** Upper bound on older-history pages fetched for one jump. */
const MAX_HISTORY_PAGES = 200;

export type SessionStepNavigationOptions = {
  activeSessionId: () => string | null;
  transcript: () => TranscriptState;
  /** Loads one older history page for the active session; false when none was added. */
  loadOlder: () => Promise<boolean>;
  revealActivityEntry: (groupId: string, entryId: string) => Promise<boolean>;
  reportError: (error: unknown) => void;
};

/**
 * Jump from a session step to the todo call that started it, paging older
 * history in until the start or the current plan's boundary is loaded.
 * A newer jump or a session switch supersedes a pending one.
 */
export function createSessionStepNavigation(options: SessionStepNavigationOptions) {
  let generation = 0;

  async function jumpToStep(sessionId: string, task: Pick<SessionTodoTask, "id" | "subject">): Promise<boolean> {
    const request = ++generation;
    const current = () => request === generation && options.activeSessionId() === sessionId;
    if (!current()) return false;
    try {
      for (let page = 0; page <= MAX_HISTORY_PAGES; page += 1) {
        const items = options.transcript().items;
        const location = locateSessionStepStart(items, task);
        if (location.kind === "found") {
          const groupId = activityGroupIdFor(items, location.itemId);
          if (!groupId) break;
          await tick();
          if (!current()) return false;
          return await options.revealActivityEntry(groupId, location.itemId) && current();
        }
        if (location.kind === "missing") break;
        const loaded = await options.loadOlder();
        if (!current()) return false;
        if (!loaded) break;
      }
      if (current()) throw new Error(`Could not find where step #${task.id} started in this session's history.`);
      return false;
    } catch (error) {
      if (current()) options.reportError(error);
      return false;
    }
  }

  return {
    jumpToStep,
    cancel: () => { generation += 1; },
  };
}
