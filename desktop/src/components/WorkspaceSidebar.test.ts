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
  });

  it("keeps the Activity Bar project icon neutral", () => {
    expect(activityBarSource).toContain('<Folder class="h-5 w-5" aria-hidden="true" />');
    expect(activityBarSource).not.toContain("ProjectFolderIcon");
    expect(activityBarSource).not.toContain("projectColors");
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
    expect(sidebarSource).toContain("<SettingsPanel configOptions={settingsConfigOptions}");
  });

  it("feeds externally observed project registry changes into background sync", () => {
    expect(sidebarSource).toContain("indicatorServiceState.poll?.registry.projectChanges");
    expect(sidebarSource).toContain("checkedAtMs === observedRegistryProjectPollAt");
    expect(sidebarSource).toContain('registryBackgroundSync.phase !== "idle"');
    expect(sidebarSource).toContain("onRegistryProjectChange(artifact)");
  });

  it("wires explicit Git and Registry project initialization actions", () => {
    expect(sidebarSource).toContain("uninitialized={gitUninitialized}");
    expect(sidebarSource).toContain("onInitialize={onGitInitialize}");
    expect(sidebarSource).toContain("projectInitialized={registryProjectInitialized}");
    expect(sidebarSource).toContain("onInitializeProject={onRegistryInitializeProject}");
    expect(sidebarViewModelSource).toContain("onGitInitialize: () => void options.git.initialize()");
    expect(sidebarViewModelSource).toContain("onRegistryInitializeProject: () => void options.registry.initializeProject()");
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
