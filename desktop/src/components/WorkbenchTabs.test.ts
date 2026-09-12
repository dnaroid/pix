import { describe, expect, it } from "vitest";
import appSource from "../App.svelte?raw";
import source from "./WorkbenchTabs.svelte?raw";

describe("WorkbenchTabs desktop interaction", () => {
  it("uses one roving ARIA tablist for session, Preview, and Git Diff surfaces", () => {
    expect(source).toContain('aria-label="Workbench tabs"');
    expect(source).toContain('role="tablist"');
    expect(source).toContain('role="tab"');
    expect(source).toContain("aria-selected={active}");
    expect(source).toContain('linearFocusIndex(index, event.key, tabs.length, "horizontal", true)');
    expect(source).toContain('data-workbench-tab-id={tab.id}');
    expect(source).toContain('tab.kind === "session"');
    expect(source).toContain('tab.kind === "preview"');
    expect(source).toContain("GitCompareArrows");
    expect(appSource).toContain("<WorkbenchTabs");
    expect(appSource).toContain("tabs={workbenchTabs}");
    expect(appSource).not.toContain("<WorkspaceEditorTabs");
  });

  it("keeps pointer close outside the normal Tab sequence and supports Delete plus middle-click close", () => {
    expect(source).toContain('tabindex="-1"');
    expect(source).toContain('event.key !== "Delete"');
    expect(source).toContain("event.button !== 1");
    expect(source).toContain("workbenchTabCloseFallback(tabs, id)");
    expect(source).toContain("if (!closed) return;");
  });

  it("keeps session-only lifecycle semantics while Preview/Diff are ordinary UI tabs", () => {
    expect(appSource).toContain('if (tab.kind === "session")');
    expect(appSource).toContain("closeSessionTab(tab.sessionId, preferredNextSessionId)");
    expect(appSource).toContain("const wasSelected = activeWorkbenchTabId === id");
    expect(appSource).toContain("if (closed && wasSelected)");
    expect(appSource).toContain("previewPane ? previewPane.requestClose()");
    expect(appSource).toContain("closeGitDiff();");
    expect(appSource).toContain("if (runningSessionIds.has(sessionId))");
    expect(appSource).toContain("Closing this tab will stop the active run. Close it?");
  });

  it("keeps the sole UI-only draft conversation non-closable", () => {
    expect(appSource).toContain("closable: !draft || tabSessions.length > 0");
    expect(appSource).toContain('const draft = session.sessionId === DRAFT_SESSION_TAB_ID');
  });
});
