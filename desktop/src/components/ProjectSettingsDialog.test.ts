import { describe, expect, it } from "vitest";
import dialogSource from "./ProjectSettingsDialog.svelte?raw";
import sidebarSource from "./WorkspaceSidebar.svelte?raw";
import switcherSource from "./ProjectSwitcher.svelte?raw";

describe("project settings dialog", () => {
  it("opens project settings from the project switcher menu and badge right-click", () => {
    expect(sidebarSource).not.toContain('title="Project settings"');
    expect(sidebarSource).toContain("export function openProjectSettings");
    expect(sidebarSource).toContain("onOpenProjectSettings={openProjectSettings}");
    expect(sidebarSource).toContain("<ProjectSettingsDialog");
    expect(switcherSource).toContain("Project settings…");
    expect(switcherSource).toContain("oncontextmenu={handleBadgeContextmenu}");
  });

  it("offers automatic/custom color modes and a native color picker", () => {
    expect(dialogSource).toContain(">Automatic<");
    expect(dialogSource).toContain(">Custom<");
    expect(dialogSource).toContain('type="color"');
    expect(dialogSource).toContain(".pi/workspace.jsonc");
    expect(dialogSource).toContain("Used by the titlebar, status-bar project name, and recent-project folders.");
  });

  it("keeps filesystem IO outside the presentation component", () => {
    expect(dialogSource).not.toContain("invoke(");
  });

  it("offers initials or an image logo from a file, AI generation, and an optional prompt", () => {
    expect(dialogSource).toContain(">Initials<");
    expect(dialogSource).toContain(">Image<");
    expect(dialogSource).toContain("Choose file…");
    expect(dialogSource).toContain("Generate with AI");
    expect(dialogSource).toContain("data-project-logo-prompt");
    expect(dialogSource).toContain("onGenerateIcon(iconPrompt.trim() || undefined)");
    expect(dialogSource).toContain("to OpenRouter");
  });

  it("can derive a custom color from the logo", () => {
    expect(dialogSource).toContain("From logo");
    expect(dialogSource).toContain("vividColorFromImageUrl(source)");
    expect(dialogSource).toContain("disabled={!iconPreview || logoColorBusy || saving}");
  });
});
