import type { SessionTabControllerOptions } from "./session-tab-controller-options";
import { createSessionSelectorActions } from "./session-selector-actions";
import { createSessionTabClosure } from "./session-tab-closure";
import { createSessionTabSelection } from "./session-tab-selection";

export function createSessionTabController(options: SessionTabControllerOptions) {
  const selection = createSessionTabSelection(options);
  const selector = createSessionSelectorActions(options, selection);
  const closure = createSessionTabClosure(options, selection.loadSession);

  return {
    loadSession: selection.loadSession,
    replaceCurrentTabWithSession: selection.replaceCurrentTabWithSession,
    closeWorkspaceSessions: closure.closeWorkspaceSessions,
    closeSessionTab: closure.closeSessionTab,
    handleSessionTabClick: selection.handleSessionTabClick,
    openSessionSelector: selector.openSessionSelector,
    closeSessionSelector: selector.closeSessionSelector,
    selectSession: selector.selectSession,
    selectSessionFromDraft: selector.selectSessionFromDraft,
    deleteSelectedSession: closure.deleteSelectedSession,
  };
}
