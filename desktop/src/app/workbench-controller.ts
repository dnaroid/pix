import {
  workbenchSessionId,
  workbenchSessionTabId,
  type WorkbenchTab,
  type WorkbenchTabId,
} from "../lib/workbench-tabs";

type WorkbenchControllerOptions = {
  tabs: () => readonly WorkbenchTab[];
  activeTabId: () => WorkbenchTabId | null;
  activeConversationTabId: () => WorkbenchTabId | null;
  setActiveTabId: (id: WorkbenchTabId | null) => void;
  handleSessionTabClick: (sessionId: string) => void;
  closeSessionTab: (sessionId: string, preferredNextSessionId?: string) => Promise<boolean>;
  previewPane: () => { requestClose: () => boolean } | null;
  closePreview: () => void;
  closeGitDiff: () => void;
  retargetPreviewAnchor: (sourceId: WorkbenchTabId, targetId: WorkbenchTabId | null) => void;
  retargetGitAnchor: (sourceId: WorkbenchTabId, targetId: WorkbenchTabId | null) => void;
};

export function createWorkbenchController(options: WorkbenchControllerOptions) {
  function retargetSessionAnchors(sourceSessionId: string, targetSessionId?: string): void {
    const sourceId = workbenchSessionTabId(sourceSessionId);
    const targetId = targetSessionId ? workbenchSessionTabId(targetSessionId) : null;
    options.retargetPreviewAnchor(sourceId, targetId);
    options.retargetGitAnchor(sourceId, targetId);
  }

  function select(id: WorkbenchTabId): void {
    const tab = options.tabs().find((candidate) => candidate.id === id);
    if (!tab || tab.disabled) return;
    options.setActiveTabId(id);
    if (tab.kind === "session") options.handleSessionTabClick(tab.sessionId);
  }

  async function close(id: WorkbenchTabId, fallbackId: WorkbenchTabId | null): Promise<boolean> {
    const tab = options.tabs().find((candidate) => candidate.id === id);
    if (!tab || tab.disabled || !tab.closable) return false;
    const wasSelected = options.activeTabId() === id;

    let closed = false;
    if (tab.kind === "session") {
      const preferredNextSessionId = workbenchSessionId(fallbackId) ?? undefined;
      closed = await options.closeSessionTab(tab.sessionId, preferredNextSessionId);
    } else if (tab.kind === "preview") {
      const pane = options.previewPane();
      closed = pane ? pane.requestClose() : (options.closePreview(), true);
    } else {
      options.closeGitDiff();
      closed = true;
    }

    if (closed && wasSelected) {
      options.setActiveTabId(fallbackId ?? options.activeConversationTabId());
    }
    return closed;
  }

  return { retargetSessionAnchors, select, close };
}
