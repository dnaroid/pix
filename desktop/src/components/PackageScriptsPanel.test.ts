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
    expect(editorSource).toContain("Saved launch commands");
    expect(editorSource).toContain("No saved commands.");
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
