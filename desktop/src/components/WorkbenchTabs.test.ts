import { describe, expect, it } from "vitest";
import titlebarViewModelSource from "../app/desktop-titlebar-view-model.svelte.ts?raw";
import sessionTabClosureSource from "../app/session-tab-closure.ts?raw";
import workbenchControllerSource from "../app/workbench-controller.ts?raw";
import workbenchModelSource from "../app/workbench-model.ts?raw";
import titlebarSource from "./DesktopTitlebar.svelte?raw";
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
    expect(source).toContain("tab.fork");
    expect(source).toContain("GitFork");
    expect(source).toContain('tab.kind === "preview"');
    expect(source).toContain("GitCompareArrows");
    expect(source).toContain("text-left text-xs text-muted-foreground");
    expect(titlebarSource).toContain("<WorkbenchTabs {...workbench} />");
    expect(titlebarViewModelSource).toContain("tabs: options.tabs()");
    expect(titlebarSource).not.toContain("<WorkspaceEditorTabs");
  });

  it("keeps pointer close outside the normal Tab sequence and supports Delete plus middle-click close", () => {
    expect(source).toContain('tabindex="-1"');
    expect(source).toContain('event.key !== "Delete"');
    expect(source).toContain("event.button !== 1");
    expect(source).toContain("workbenchTabCloseFallback(tabs, id)");
    expect(source).toContain("if (!closed) return;");
  });

  it("keeps session-only lifecycle semantics while Preview/Diff are ordinary UI tabs", () => {
    expect(workbenchControllerSource).toContain('if (tab.kind === "session")');
    expect(workbenchControllerSource).toContain("options.closeSessionTab(tab.sessionId, preferredNextSessionId)");
    expect(workbenchControllerSource).toContain("const wasSelected = options.activeTabId() === id");
    expect(workbenchControllerSource).toContain("if (closed && wasSelected)");
    expect(workbenchControllerSource).toContain("pane ? pane.requestClose() : (options.closePreview(), true)");
    expect(workbenchControllerSource).toContain("options.closeGitDiff();");
    expect(sessionTabClosureSource).toContain("if (options.promptRunning(sessionId))");
    expect(sessionTabClosureSource).toContain("Closing this tab will stop the active run. Close it?");
  });

  it("keeps the sole UI-only draft conversation non-closable", () => {
    expect(workbenchModelSource).toContain("closable: !draft || options.realSessionCount > 0");
    expect(workbenchModelSource).toContain("const draft = session.sessionId === options.draftSessionTabId");
  });
});
