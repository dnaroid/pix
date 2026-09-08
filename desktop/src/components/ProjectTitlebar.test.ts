import { describe, expect, it } from "vitest";
import titlebarSource from "./ProjectTitlebar.svelte?raw";

describe("ProjectTitlebar project opening actions", () => {
  it("offers a system folder picker that opens the chosen project in a new window", () => {
    expect(titlebarSource).toContain("onChooseWorkspaceInNewWindow");
    expect(titlebarSource).toContain("onclick={onChooseWorkspaceInNewWindow}");
    expect(titlebarSource).toContain("Choose project folder in new window…");
  });

  it("keeps the selector and new-window actions usable while current-window navigation is busy", () => {
    expect(titlebarSource).toContain("currentWindowDisabled");
    expect(titlebarSource).toContain("disabled={currentWindowDisabled}");
    expect(titlebarSource).not.toContain("{disabled}");
    expect(titlebarSource).toContain("onclick={() => onOpenProjectInNewWindow(project)}");
    expect(titlebarSource).toContain("onclick={onChooseWorkspaceInNewWindow}");
  });
});
