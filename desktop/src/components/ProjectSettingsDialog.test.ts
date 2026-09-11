import { describe, expect, it } from "vitest";
import dialogSource from "./ProjectSettingsDialog.svelte?raw";
import sidebarSource from "./WorkspaceSidebar.svelte?raw";

describe("project settings dialog", () => {
  it("exposes project settings from the Project panel header", () => {
    expect(sidebarSource).toContain('title="Project settings"');
    expect(sidebarSource).toContain("SlidersHorizontal");
    expect(sidebarSource).toContain("<ProjectSettingsDialog");
  });

  it("offers automatic/custom color modes and a native color picker", () => {
    expect(dialogSource).toContain(">Automatic<");
    expect(dialogSource).toContain(">Custom<");
    expect(dialogSource).toContain('type="color"');
    expect(dialogSource).toContain(".pi/workspace.jsonc");
  });

  it("keeps filesystem IO outside the presentation component", () => {
    expect(dialogSource).not.toContain("invoke(");
  });
});
