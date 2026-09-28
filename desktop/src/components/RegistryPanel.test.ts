import { describe, expect, it } from "vitest";
import panelSource from "./RegistryPanel.svelte?raw";
import sidebarSource from "./WorkspaceSidebar.svelte?raw";

describe("RegistryPanel refresh lifecycle", () => {
  it("refreshes only from an explicit user action", () => {
    expect(panelSource).not.toContain("onMount");
    expect(sidebarSource).toContain('title="Refresh registry"');
    expect(sidebarSource).toContain("onclick={onRegistryRefresh}");
  });

  it("keeps project-sync initialization separate from remote registry configuration", () => {
    expect(panelSource).toContain("projectInitialized === false");
    expect(panelSource).toContain("Project sync is not initialized");
    expect(panelSource).toContain("onclick={onInitializeProject}");
    expect(panelSource).toContain('actionId === "initialize-project"');
  });

  it("shows local .pi storage and cleans only reclaimable junk", () => {
    expect(panelSource).toContain(".pi storage");
    expect(panelSource).toContain("formatPiSize(projectPiSizeBytes)");
    expect(panelSource).toContain("projectPiCleanupBytes");
    expect(panelSource).toContain("projectPiCleanupAvailable");
    expect(panelSource).toContain("reclaimable");
    expect(panelSource).toContain('actionId === "cleanup-project"');
    expect(panelSource).toContain("window.confirm");
    expect(panelSource).toContain("clears all contents of artifacts/ and subagents/");
    expect(panelSource).toContain("removes non-canonical top-level files and directories");
    expect(panelSource).toContain("Canonical project state, config, agents/, plans/, skills/ and task-attachments/ are preserved");
    expect(panelSource).toContain("onCleanProject()");
    expect(panelSource).toContain("projectPiStorageLoading");
    expect(panelSource).toContain("projectPiStorageError");
    expect(panelSource).toContain("Checking… total");
  });

  it("does not gate Registry controls on conversation session readiness", () => {
    expect(sidebarSource).toContain("remoteDisabled={!registryReady}");
    expect(sidebarSource).not.toContain("disabled={!sessionReady || registryActionId !== null}");
    expect(panelSource).not.toContain("Open a ready project session to manage its registry.");
  });

  it("treats a missing project key as a non-Git project-sync setup state", () => {
    expect(panelSource).toContain("Project sync needs a key");
    expect(panelSource).toContain("Set a project key; Git is optional");
  });

  it("separates reusable resources into Installed and Marketplace views", () => {
    expect(panelSource).toContain('let catalogSection = $state<RegistryCatalogSection>("installed")');
    expect(panelSource).toContain('aria-label="Installed resources"');
    expect(panelSource).toContain('aria-label="Marketplace resources"');
    expect(panelSource).toContain("registryCatalogItems(catalogItems, catalogSection)");
    expect(panelSource).toContain('.filter((item) => item.type !== "project")');
    expect(panelSource).not.toContain('<option value="project">Project</option>');
    expect(panelSource).toContain("onclick={() => item.artifact && onOpenProjectArtifact(item.artifact)}");
  });

  it("keeps Installed usable without Marketplace or project-sync initialization", () => {
    expect(panelSource).toContain('!snapshot.configured && catalogSection === "marketplace"');
    expect(panelSource).toContain("Marketplace is not connected");
    expect(panelSource).toContain("Project sync is not initialized");
    expect(panelSource).not.toContain('{#if projectInitialized === false}\n      <div class="px-3 py-6 text-center">');
  });
});
