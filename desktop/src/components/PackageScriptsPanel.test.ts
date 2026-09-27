import { describe, expect, it } from "vitest";
import source from "./PackageScriptsPanel.svelte?raw";
import editorSource from "./SavedLaunchCommands.svelte?raw";
import sidebarSource from "./WorkspaceSidebar.svelte?raw";
import sidebarViewModelSource from "../app/desktop-sidebar-view-model.svelte.ts?raw";

describe("PackageScriptsPanel saved launch commands", () => {
  it("supports project-scoped command CRUD and running without requiring package scripts", () => {
    expect(source).toContain("controller.launchCommands");
    expect(source).toContain('onSave={controller.saveLaunchCommand}');
    expect(source).toContain('onDelete={controller.deleteLaunchCommand}');
    expect(source).toContain('onRun={controller.runLaunchCommand}');
    expect(source).toContain('aria-label="Launch commands and terminals"');
    expect(source).toContain("{#if snapshot?.exists}");
    expect(source).not.toContain('snapshot?.packageName ?? "package.json"');
    expect(editorSource).toContain("Saved launch commands");
    expect(editorSource).toContain("No saved commands.");
    expect(editorSource).toContain('<Play class="h-3 w-3"');
  });

  it("moves launch refresh into the shared sidebar header and uses launch-command naming", () => {
    expect(source).toContain("export function refresh(): void");
    expect(source).not.toContain('title="Refresh package scripts"');
    expect(sidebarSource).toContain('scripts: "Launch Commands"');
    expect(sidebarSource).toContain('title="Refresh launch commands"');
    expect(sidebarSource).toContain("packageScriptsPanel?.refresh()");
    expect(sidebarSource).toContain("bind:this={packageScriptsPanel}");
  });

  it("wires successful workspace settings saves to registry workspace sync", () => {
    expect(source).toContain("afterWorkspaceSave: (savedWorkspace) => afterWorkspaceSave(savedWorkspace)");
    expect(sidebarSource).toContain("afterWorkspaceSave={onWorkspaceSettingsSave}");
    expect(sidebarViewModelSource).toContain('options.registry.scheduleProjectSync("workspace")');
    expect(sidebarViewModelSource).toContain("if (workspace === options.workspace())");
  });

  it("provides guarded editor actions, confirmation, focus, and Escape cancellation", () => {
    expect(editorSource).toContain("crypto.randomUUID()");
    expect(editorSource).toContain("confirm(`Delete “${command.name}” launch command?`)");
    expect(editorSource).toContain("if (busy ||");
    expect(editorSource).toContain("nameInput?.focus()");
    expect(editorSource).toContain('event.key !== "Escape"');
    expect(editorSource).toContain('aria-label="Shell command"');
  });
});
