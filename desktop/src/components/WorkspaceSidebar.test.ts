import { describe, expect, it } from "vitest";
import sidebarSource from "./WorkspaceSidebar.svelte?raw";
import activityBarSource from "./WorkspaceSidebarActivityBar.svelte?raw";
import indicatorDotSource from "./SidebarIndicatorDot.svelte?raw";
import tasksPanelSource from "./WorkspaceSidebarTasksPanel.svelte?raw";
import layoutControllerSource from "./workspace-sidebar-layout-controller.svelte.ts?raw";
import statusMenuControllerSource from "./workspace-sidebar-status-menu-controller.svelte.ts?raw";
import sidebarViewModelSource from "../app/desktop-sidebar-view-model.svelte.ts?raw";
import navigationViewModelSource from "../app/desktop-navigation-view-model-services.ts?raw";

describe("WorkspaceSidebar project sizing", () => {
  it("creates tasks from group headers with the selected type instead of the toolbar", () => {
    expect(sidebarSource).toContain("function openCreate(type: ProjectTaskType): void");
    expect(sidebarSource).toContain("if (!workspace || busy) return;");
    expect(sidebarSource).toContain("taskType = type;");
    expect(sidebarSource).toContain("onCreate={openCreate}");
    expect(tasksPanelSource).toContain("onclick={() => onCreate(group.type)}");
    expect(sidebarSource).not.toContain('aria-label="Add task"');
  });

  it("uses self-refreshing eligibility for the combined Git command and does not open a panel", () => {
    expect(sidebarSource).toContain('"git.commit-push": Boolean(onGitStageGenerateCommitPush) && gitAssistantReady && !gitBusy && !gitStageGenerateCommitPushBlockedReason(gitSnapshot)');
    expect(sidebarSource).toContain('"git.commit-push": () => { void onGitStageGenerateCommitPush?.(); }');
  });
  it("does not reveal panels for work commands; inspection remains separate", () => {
    const workActions = ["project.retry", "tasks.reload", "git.refresh", "git.fix-ci", "git.fetch", "git.push", "git.commit-push", "registry.refresh", "registry.push-project-resources", "idx.review"];
    const handlers = sidebarSource.slice(sidebarSource.indexOf("handlers: {"), sidebarSource.indexOf("const indicatorMenuController"));
    for (const id of workActions) {
      expect(handlers).toContain(`"${id}":`);
    }
    expect(handlers).not.toContain("revealIndicatorTab");
    expect(sidebarSource).toContain('"project.retry": () => { void projectRetry.retry(); }');
    expect(sidebarSource).toContain("reveal: revealIndicatorTab");
  });
  it("uses the switcher's measured minimum in both resize clamping and CSS sizing", () => {
    expect(layoutControllerSource).toContain("let projectSwitcherMinimumWidth = $state(MIN_WIDTH)");
    expect(layoutControllerSource).toContain('if (tab === "project") return Math.max(MIN_WIDTH, projectSwitcherMinimumWidth)');
    expect(sidebarSource).toContain('style:min-width={`${layoutController.renderedMinWidth}px`}');
    expect(sidebarSource).toContain("onMinimumWidthChange={layoutController.setProjectSwitcherMinimumWidth}");
  });

  it("does not let Source Control shrink below its desktop action layout", () => {
    expect(layoutControllerSource).toContain("const GIT_MIN_WIDTH = 360");
    expect(layoutControllerSource).toContain('if (tab === "git") return GIT_MIN_WIDTH');
  });

  it("lets any sidebar view grow until the main workspace reaches its minimum width", () => {
    expect(layoutControllerSource).toContain("const MIN_MAIN_WORKSPACE_WIDTH = 280");
    expect(layoutControllerSource).toContain("viewportWidth - ACTIVITY_BAR_WIDTH - MIN_MAIN_WORKSPACE_WIDTH");
    expect(layoutControllerSource).not.toContain("DEFAULT_MAX_WIDTH");
    expect(layoutControllerSource).not.toContain("SCRIPTS_MAX_WIDTH");
    expect(layoutControllerSource).not.toContain("IDX_MAX_WIDTH");
    expect(layoutControllerSource).not.toContain("sidebarMaxWidth");
  });

  it("treats the Activity Bar as one vertical keyboard toolbar", () => {
    expect(activityBarSource).toContain('role="toolbar"');
    expect(activityBarSource).toContain('aria-orientation="vertical"');
    expect(activityBarSource).toContain("data-sidebar-tab");
    expect(activityBarSource).toContain('linearFocusIndex(currentIndex, event.key, SIDEBAR_TABS.length, "vertical", true)');
  });

  it("keeps the Activity Bar on the compact 40px desktop rail", () => {
    expect(layoutControllerSource).toContain("const ACTIVITY_BAR_WIDTH = 40");
    expect(activityBarSource).toContain("h-full w-10 shrink-0");
    expect(activityBarSource).toContain("h-10 w-10 place-items-center");
    expect(activityBarSource).toContain("pt-1 pb-2");
    expect(activityBarSource).toContain("mt-auto grid h-10 w-10 -translate-y-px");
  });

  it("keeps the Activity Bar project icon neutral", () => {
    expect(activityBarSource).toContain('<Folder class="h-5 w-5" aria-hidden="true" />');
    expect(activityBarSource).not.toContain("ProjectFolderIcon");
    expect(activityBarSource).not.toContain("projectColors");
  });

  it("shows selected Activity Bar styling only while the sidebar is expanded", () => {
    expect(activityBarSource).toContain("return activeTab === tab && !collapsed;");
    expect(activityBarSource).toContain('selected("project") ? "border-l-primary bg-panel-selected text-foreground"');
    expect(activityBarSource).toContain('selected("settings") ? "border-l-primary bg-panel-selected text-foreground"');
  });

  it("gives every expanded sidebar panel a shared close button", () => {
    expect(sidebarSource).toContain('import X from "@lucide/svelte/icons/x"');
    expect(sidebarSource).toContain("function closeActivePanel(): void");
    expect(sidebarSource).toContain("selectTab(activeTab);");
    expect(sidebarSource).toContain('title={`Close ${activeTabTitle}`}');
    expect(sidebarSource).toContain('aria-label={`Close ${activeTabTitle}`}');
    expect(sidebarSource).toContain("bg-sidebar pl-3 pr-1");
  });

  it("uses the shared menu navigation contract for task status", () => {
    expect(statusMenuControllerSource).toContain("menuFocusIndex(navigationItems, currentIndex, event.key)");
    expect(statusMenuControllerSource).toContain("menuTypeaheadFocusIndex(navigationItems, currentIndex, query)");
    expect(tasksPanelSource).toContain('role="menuitemradio"');
  });

  it("animates the shared Activity Bar dot only for transient background activity", () => {
    expect(indicatorDotSource).toContain("indicator.animated");
    expect(indicatorDotSource).toContain("motion-safe:animate-ping");
    expect(sidebarViewModelSource).toContain('backgroundSyncState.phase === "syncing" ? "background-sync" : null');
  });

  it("passes the live ACP model catalog through the sidebar into Settings", () => {
    expect(navigationViewModelSource).toContain("configOptions: options.displayedConfigOptions");
    expect(sidebarViewModelSource).toContain("settingsConfigOptions: options.configOptions()");
    expect(sidebarSource).toMatch(/<SettingsPanel\b[^>]*configOptions=\{settingsConfigOptions\}/);
    expect(sidebarSource).toContain("bind:this={settingsPanel}");
  });

  it("routes externally observed registry changes through the local-state observer", () => {
    expect(sidebarSource).toContain("indicatorServiceState.poll?.registry.projectChanges");
    expect(sidebarSource).toContain("checkedAtMs === observedRegistryProjectPollAt");
    expect(sidebarSource).toContain("if (workspace !== observedWorkspace) return;");
    expect(sidebarSource).toContain("onRegistryProjectChange(artifact)");
    expect(sidebarViewModelSource).toContain("onRegistryProjectChange: options.registry.observeProjectChange");
  });

  it("wires explicit Git and Registry project initialization actions", () => {
    expect(sidebarSource).toContain("uninitialized={gitUninitialized}");
    expect(sidebarSource).toContain("onInitialize={onGitInitialize}");
    expect(sidebarSource).toContain("projectInitialized={registryProjectInitialized}");
    expect(sidebarSource).toContain("onInitializeProject={onRegistryInitializeProject}");
    expect(sidebarViewModelSource).toContain("onGitInitialize: () => void options.git.initialize()");
    expect(sidebarViewModelSource).toContain("onRegistryInitializeProject: () => void options.registry.initializeProject()");
  });

  it("offers a toolbar shortcut to browse plans regardless of project-sync review state", () => {
    expect(sidebarSource).toContain('import FileText from "\u0040lucide/svelte/icons/file-text"');
    expect(sidebarSource).toContain('title="Browse plans"');
    expect(sidebarSource).toContain('aria-label="Browse plans"');
    expect(sidebarSource).toContain('onclick={() => openRegistryProjectArtifact("plans")}');
  });

  it("wires Registry .pi storage and garbage cleanup through the sidebar", () => {
    expect(sidebarSource).toContain("projectPiSizeBytes={registryProjectPiSizeBytes}");
    expect(sidebarSource).toContain("projectPiCleanupBytes={registryProjectPiCleanupBytes}");
    expect(sidebarSource).toContain("projectPiCleanupAvailable={registryProjectPiCleanupAvailable}");
    expect(sidebarSource).toContain("projectPiStorageLoading={registryProjectPiStorageLoading}");
    expect(sidebarSource).toContain("projectPiStorageError={registryProjectPiStorageError}");
    expect(sidebarSource).toContain("onCleanProject={onRegistryCleanProject}");
    expect(sidebarViewModelSource).toContain("registryProjectPiSizeBytes: options.registry.projectPiSizeBytes");
    expect(sidebarViewModelSource).toContain("registryProjectPiCleanupBytes: options.registry.projectPiCleanupBytes");
    expect(sidebarViewModelSource).toContain("registryProjectPiCleanupAvailable: options.registry.projectPiCleanupAvailable");
    expect(sidebarViewModelSource).toContain("registryProjectPiStorageLoading: options.registry.projectPiStorageLoading");
    expect(sidebarViewModelSource).toContain("registryProjectPiStorageError: options.registry.projectPiStorageError");
    expect(sidebarViewModelSource).toContain("onRegistryCleanProject: () => void options.registry.cleanProject()");
  });
});
