import { describe, expect, it } from "vitest";
import {
  buildWorkbenchTabs,
  normalizeWorkbenchTab,
  workbenchSessionId,
  workbenchSessionTabId,
  workbenchTabCloseFallback,
  type WorkbenchDiffTab,
  type WorkbenchPreviewTab,
  type WorkbenchSessionTab,
  type WorkbenchTerminalTab,
} from "./workbench-tabs";

function session(sessionId: string): WorkbenchSessionTab {
  return {
    id: workbenchSessionTabId(sessionId),
    kind: "session",
    sessionId,
    label: sessionId,
    title: sessionId,
    panelId: "conversation-workspace",
    closable: true,
    running: false,
    draft: false,
    fork: false,
    statusKind: "idle",
  };
}

const preview: WorkbenchPreviewTab = {
  id: "preview",
  kind: "preview",
  label: "README.md",
  title: "README.md",
  panelId: "workbench-panel-preview",
  closable: true,
  dirty: false,
};

const diff: WorkbenchDiffTab = {
  id: "git-diff",
  kind: "diff",
  label: "Git Diff",
  title: "Git Diff",
  panelId: "workbench-panel-git-diff",
  closable: true,
  busy: false,
};

const terminal: WorkbenchTerminalTab = {
  id: "terminal",
  kind: "terminal",
  label: "Terminal",
  title: "Interactive terminal",
  panelId: "workbench-panel-terminal",
  closable: true,
};

describe("workbench tabs", () => {
  it("keeps canonical session order while inserting editor surfaces beside their opener", () => {
    const tabs = buildWorkbenchTabs([session("a"), session("b")], [
      { tab: preview, insertAfterId: workbenchSessionTabId("a"), openedOrder: 1 },
      { tab: diff, insertAfterId: "preview", openedOrder: 2 },
    ]);
    expect(tabs.map((tab) => tab.id)).toEqual([
      "session:a",
      "preview",
      "git-diff",
      "session:b",
    ]);
  });

  it("keeps runtime session identity separate from workbench-only tabs", () => {
    expect(workbenchSessionId(workbenchSessionTabId("session-1"))).toBe("session-1");
    expect(workbenchSessionId("preview")).toBeNull();
    expect(workbenchSessionId("terminal")).toBeNull();
    expect(workbenchTabCloseFallback([session("a"), preview, session("b")], "preview")).toBe("session:b");
    expect(normalizeWorkbenchTab("git-diff", [session("a"), preview], workbenchSessionTabId("a")))
      .toBe("session:a");
  });

  it("places Terminal like other workbench-only surfaces without changing session order", () => {
    const tabs = buildWorkbenchTabs([session("a"), session("b")], [
      { tab: terminal, insertAfterId: workbenchSessionTabId("a"), openedOrder: 1 },
    ]);
    expect(tabs.map((tab) => tab.id)).toEqual(["session:a", "terminal", "session:b"]);
  });
});
