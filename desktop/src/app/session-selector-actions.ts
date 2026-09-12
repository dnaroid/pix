import { DRAFT_SESSION_TAB_ID } from "./draft-session.svelte";
import type {
  SessionLoader,
  SessionReplacer,
  SessionTabControllerOptions,
} from "./session-tab-controller-options";

export function createSessionSelectorActions(
  options: SessionTabControllerOptions,
  selection: { loadSession: SessionLoader; replaceCurrentTabWithSession: SessionReplacer },
) {
  function openSessionSelector(query = "", mode: "open" | "delete" = "open"): void {
    if (!options.workspace() || !options.statusReady()) return;
    options.tabs.openSelector(query, mode);
    void options.catalog.refresh();
  }

  function closeSessionSelector(): void {
    options.tabs.closeSelector();
  }

  function selectSession(sessionId: string): void {
    if (options.draft.active) {
      void selectSessionFromDraft(sessionId);
      return;
    }
    if (sessionId === options.state.sessionId) {
      options.tabs.closeSelector();
      return;
    }
    void selection.replaceCurrentTabWithSession(sessionId);
  }

  async function selectSessionFromDraft(sessionId: string): Promise<void> {
    if (!options.draft.active || options.sessionMutationRunning()) return;
    options.draft.close();
    options.clearPrompt();
    options.invalidateAttachmentDraft();
    options.retargetWorkbenchAnchors(DRAFT_SESSION_TAB_ID, sessionId);
    await selection.loadSession(sessionId);
  }

  return { openSessionSelector, closeSessionSelector, selectSession, selectSessionFromDraft };
}
