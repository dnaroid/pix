import { describe, expect, it } from "vitest";
import navigationViewModelSource from "../app/desktop-navigation-view-model-services.ts?raw";
import titlebarViewModelSource from "../app/desktop-titlebar-view-model.svelte.ts?raw";
import sessionTabClosureSource from "../app/session-tab-closure.ts?raw";
import workbenchControllerSource from "../app/workbench-controller.ts?raw";
import workbenchModelSource from "../app/workbench-model.ts?raw";
import titlebarSource from "./DesktopTitlebar.svelte?raw";
import projectSwitcherSource from "./ProjectSwitcher.svelte?raw";
import statusIconSource from "./SessionTabStatusIcon.svelte?raw";
import source from "./WorkbenchTabs.svelte?raw";

describe("WorkbenchTabs desktop interaction", () => {
  it("uses one roving ARIA tablist for sessions and auxiliary workbench surfaces", () => {
    expect(source).toContain('aria-label="Workbench tabs"');
    expect(source).toContain('role="tablist"');
    expect(source).toContain('role="tab"');
    expect(source).toContain("aria-selected={active}");
    expect(source).toContain('linearFocusIndex(index, event.key, tabs.length, "horizontal", true)');
    expect(source).toContain('data-workbench-tab-id={tab.id}');
    expect(source).toContain('tab.kind === "session"');
    expect(source).toContain("<SessionTabStatusIcon kind={tab.statusKind} {active} />");
    expect(source).toContain("tab.fork");
    expect(source).toContain("GitFork");
    expect(source).toContain('tab.kind === "preview"');
    expect(source).toContain("GitCompareArrows");
    expect(source).toContain('tab.kind === "terminal"');
    expect(source).toContain("SquareTerminal");
    expect(source).toContain("text-left text-xs text-muted-foreground");
    expect(titlebarSource).toContain("<WorkbenchTabs {...workbench} />");
    expect(titlebarViewModelSource).toContain("tabs: options.tabs()");
    expect(titlebarSource).not.toContain("<WorkspaceEditorTabs");
  });

  it("uses the shared project selector as a clickable titlebar project badge", () => {
    expect(titlebarSource).toContain('<ProjectSwitcher {...projectSwitcher} variant="titlebar" />');
    expect(titlebarSource.indexOf("<ProjectSwitcher")).toBeLessThan(titlebarSource.indexOf("<WorkbenchTabs {...workbench} />"));
    expect(projectSwitcherSource).toContain("data-project-badge");
    expect(projectSwitcherSource).toContain("{projectAbbreviation(workspace)}");
    expect(projectSwitcherSource).toContain('aria-haspopup="menu"');
    expect(projectSwitcherSource).toContain("aria-expanded={open}");
    expect(projectSwitcherSource).toContain('variant === "titlebar"');
    expect(projectSwitcherSource).toContain("style:--project-titlebar-color={projectColors.get(workspace)}");
    expect(projectSwitcherSource).toContain("style:--project-titlebar-hue={projectFolderHue(workspace)}");
    expect(projectSwitcherSource).toContain("background-color: var(--project-titlebar-color");
    expect(navigationViewModelSource).not.toContain("projectColors.get(options.workspace())");
  });

  it("subtly tints the window titlebar with the active project identity color", () => {
    expect(titlebarSource).toContain("projectFolderHue(projectWorkspace)");
    expect(titlebarSource).toContain("style:--project-window-titlebar-color={projectTitlebarColor}");
    expect(titlebarSource).toContain("style:--project-window-titlebar-hue={projectTitlebarHue}");
    expect(titlebarSource).toContain("project-window-titlebar");
    expect(titlebarSource).toContain("color-mix(");
    expect(titlebarSource).toContain("8%");
    expect(titlebarSource).toContain("var(--window-titlebar)");
  });

  it("keeps pointer close outside the normal Tab sequence and supports Delete plus middle-click close", () => {
    expect(source).toContain('tabindex="-1"');
    expect(source).toContain('event.key !== "Delete"');
    expect(source).toContain("event.button !== 1");
    expect(source).toContain("workbenchTabCloseFallback(tabs, id)");
    expect(source).toContain("if (!closed) return;");
  });

  it("shrink-wraps the tablist and New Conversation while allowing only the tablist to shrink", () => {
    const tablistStart = source.indexOf('role="tablist"');
    const newConversation = source.lastIndexOf("data-session-new");
    const dragRegion = source.indexOf("data-tauri-drag-region");

    expect(source).toContain("min-w-0 w-fit flex-[0_1_auto]");
    expect(source).toContain("min-w-0 w-max flex-[0_1_auto]");
    expect(source).not.toContain("flex-[1_1_auto]");
    expect(source).not.toContain("max-w-[calc(");
    expect(source).toContain("w-6 shrink-0");
    expect(tablistStart).toBeGreaterThanOrEqual(0);
    expect(newConversation).toBeGreaterThan(tablistStart);
    expect(dragRegion).toBeGreaterThan(newConversation);
  });

  it("matches every tab's intrinsic preferred width to its flex basis", () => {
    expect(source).toContain("min-w-[120px] w-[220px] flex-[0_1_220px]");
    expect(source).toContain("max-[760px]:w-[200px] max-[760px]:basis-[200px]");
    expect(source).not.toContain("max-w-[240px]");
  });

  it("keeps session-only lifecycle semantics while auxiliary surfaces close locally", () => {
    expect(workbenchControllerSource).toContain('if (tab.kind === "session")');
    expect(workbenchControllerSource).toContain("options.closeSessionTab(tab.sessionId, preferredNextSessionId)");
    expect(workbenchControllerSource).toContain("const wasSelected = options.activeTabId() === id");
    expect(workbenchControllerSource).toContain("if (closed && wasSelected)");
    expect(workbenchControllerSource).toContain("pane ? pane.requestClose() : (options.closePreview(), true)");
    expect(workbenchControllerSource).toContain("options.closeGitDiff();");
    expect(workbenchControllerSource).toContain("options.closeTerminal();");
    expect(sessionTabClosureSource).toContain("if (options.promptRunning(sessionId))");
    expect(sessionTabClosureSource).toContain("Closing this tab will stop the active run. Close it?");
  });

  it("keeps the sole UI-only draft conversation non-closable", () => {
    expect(workbenchModelSource).toContain("closable: !draft || options.realSessionCount > 0");
    expect(workbenchModelSource).toContain("const draft = session.sessionId === options.draftSessionTabId");
  });

  it("uses semantic IDE icons for session state instead of a color-only activity dot", () => {
    expect(statusIconSource).toContain("CircleCheck");
    expect(statusIconSource).toContain("LoaderCircle");
    expect(statusIconSource).toContain("Pause");
    expect(statusIconSource).toContain("CircleHelp");
    expect(statusIconSource).toContain("TriangleAlert");
    expect(statusIconSource).toContain("animate-spin text-tool-info");
    expect(statusIconSource).toContain('kind === "paused"');
    expect(statusIconSource).toContain('<Pause class="h-3.5 w-3.5 text-tool-info"');
    expect(statusIconSource).toContain('kind === "unseen-complete"');
    expect(statusIconSource).toContain("bg-primary ring-1 ring-background");
    expect(source).not.toContain('h-[7px] w-[7px] shrink-0 rounded-full border');
  });
});
