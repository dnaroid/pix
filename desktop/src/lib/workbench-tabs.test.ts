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
    runtimeActive: sessionId === "a",
    running: false,
    draft: false,
    activityTone: "idle",
    activityLabel: "Session idle",
    pulsing: false,
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
    expect(workbenchTabCloseFallback([session("a"), preview, session("b")], "preview")).toBe("session:b");
    expect(normalizeWorkbenchTab("git-diff", [session("a"), preview], workbenchSessionTabId("a")))
      .toBe("session:a");
  });
});
