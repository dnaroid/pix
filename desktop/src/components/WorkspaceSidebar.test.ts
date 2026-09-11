import { describe, expect, it } from "vitest";
import sidebarSource from "./WorkspaceSidebar.svelte?raw";

describe("WorkspaceSidebar project sizing", () => {
  it("uses the switcher's measured minimum in both resize clamping and CSS sizing", () => {
    expect(sidebarSource).toContain("let projectSwitcherMinimumWidth = $state(MIN_WIDTH)");
    expect(sidebarSource).toContain('if (tab === "project") return Math.max(MIN_WIDTH, projectSwitcherMinimumWidth)');
    expect(sidebarSource).toContain('style:min-width={`${renderedSidebarMinWidth}px`}');
    expect(sidebarSource).toContain("onMinimumWidthChange={setProjectSwitcherMinimumWidth}");
  });

  it("treats the Activity Bar as one vertical keyboard toolbar", () => {
    expect(sidebarSource).toContain('role="toolbar"');
    expect(sidebarSource).toContain('aria-orientation="vertical"');
    expect(sidebarSource).toContain("data-sidebar-tab");
    expect(sidebarSource).toContain('linearFocusIndex(currentIndex, event.key, SIDEBAR_TABS.length, "vertical", true)');
  });

  it("uses the shared menu navigation contract for task status", () => {
    expect(sidebarSource).toContain("menuFocusIndex(items, currentIndex, event.key)");
    expect(sidebarSource).toContain("menuTypeaheadFocusIndex(items, currentIndex, query)");
    expect(sidebarSource).toContain('role="menuitemradio"');
  });
});
