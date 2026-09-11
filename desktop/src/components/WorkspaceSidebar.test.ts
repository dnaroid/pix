import { describe, expect, it } from "vitest";
import sidebarSource from "./WorkspaceSidebar.svelte?raw";

describe("WorkspaceSidebar project sizing", () => {
  it("uses the switcher's measured minimum in both resize clamping and CSS sizing", () => {
    expect(sidebarSource).toContain("let projectSwitcherMinimumWidth = $state(MIN_WIDTH)");
    expect(sidebarSource).toContain('if (tab === "project") return Math.max(MIN_WIDTH, projectSwitcherMinimumWidth)');
    expect(sidebarSource).toContain('style:min-width={`${renderedSidebarMinWidth}px`}');
    expect(sidebarSource).toContain("onMinimumWidthChange={setProjectSwitcherMinimumWidth}");
  });
});
