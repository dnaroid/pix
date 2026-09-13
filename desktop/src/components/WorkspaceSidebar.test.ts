import { describe, expect, it } from "vitest";
import sidebarSource from "./WorkspaceSidebar.svelte?raw";
import activityBarSource from "./WorkspaceSidebarActivityBar.svelte?raw";
import indicatorDotSource from "./SidebarIndicatorDot.svelte?raw";
import tasksPanelSource from "./WorkspaceSidebarTasksPanel.svelte?raw";
import layoutControllerSource from "./workspace-sidebar-layout-controller.svelte.ts?raw";
import statusMenuControllerSource from "./workspace-sidebar-status-menu-controller.svelte.ts?raw";
import sidebarViewModelSource from "../app/desktop-sidebar-view-model.svelte.ts?raw";

describe("WorkspaceSidebar project sizing", () => {
  it("uses the switcher's measured minimum in both resize clamping and CSS sizing", () => {
    expect(layoutControllerSource).toContain("let projectSwitcherMinimumWidth = $state(MIN_WIDTH)");
    expect(layoutControllerSource).toContain('if (tab === "project") return Math.max(MIN_WIDTH, projectSwitcherMinimumWidth)');
    expect(sidebarSource).toContain('style:min-width={`${layoutController.renderedMinWidth}px`}');
    expect(sidebarSource).toContain("onMinimumWidthChange={layoutController.setProjectSwitcherMinimumWidth}");
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

  it("feeds externally observed project registry changes into background sync", () => {
    expect(sidebarSource).toContain("indicatorServiceState.poll?.registry.projectChanges");
    expect(sidebarSource).toContain("checkedAtMs === observedRegistryProjectPollAt");
    expect(sidebarSource).toContain('registryBackgroundSync.phase !== "idle"');
    expect(sidebarSource).toContain("onRegistryProjectChange(artifact)");
  });
});
