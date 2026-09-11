import { describe, expect, it } from "vitest";
import switcherSource from "./ProjectSwitcher.svelte?raw";

describe("ProjectSwitcher project opening actions", () => {
  it("offers a system folder picker that opens the chosen project in a new window", () => {
    expect(switcherSource).toContain("onChooseWorkspaceInNewWindow");
    expect(switcherSource).toContain("onclick={chooseWorkspaceInNewWindow}");
    expect(switcherSource).toContain("Open folder in new window…");
  });

  it("keeps new-window actions usable while current-window navigation is busy", () => {
    expect(switcherSource).toContain("currentWindowDisabled");
    expect(switcherSource).toContain("disabled={currentWindowDisabled}");
    expect(switcherSource).toContain("onclick={() => openProjectInNewWindow(project)}");
  });

  it("behaves as a keyboard navigable command menu", () => {
    expect(switcherSource).toContain('aria-haspopup="menu"');
    expect(switcherSource).toContain('role="menu"');
    expect(switcherSource).toContain('role="menuitem"');
    expect(switcherSource).toContain("menuFocusIndex");
    expect(switcherSource).toContain("menuTypeaheadFocusIndex");
  });

  it("renders per-project override colors without owning filesystem IO", () => {
    expect(switcherSource).toContain("projectColors.get(workspace)");
    expect(switcherSource).toContain("projectColors.get(project)");
    expect(switcherSource).not.toContain("invoke(");
  });

  it("keeps a visible chevron affordance on the active project row", () => {
    expect(switcherSource).toContain("ChevronDown");
    expect(switcherSource).toContain("border-sidebar-border bg-background/55");
  });

  it("shows parent directories instead of duplicating project basenames in path rows", () => {
    expect(switcherSource).toContain("projectParentPath(workspace)");
    expect(switcherSource).toContain("projectParentPath(project)");
  });

  it("reports a measured bounded minimum width without using the project path", () => {
    expect(switcherSource).toContain("projectSwitcherMinimumWidth");
    expect(switcherSource).toContain("onMinimumWidthChange?.(width)");
    expect(switcherSource).toContain("projectNameWidth: name?.scrollWidth ?? 0");
    expect(switcherSource).not.toContain("projectNameWidth: projectParentPath");
  });
});
