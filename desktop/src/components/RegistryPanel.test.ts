import { describe, expect, it } from "vitest";
import panelSource from "./RegistryPanel.svelte?raw";
import diffPanelSource from "./RegistryDiffPanel.svelte?raw";
import sidebarSource from "./WorkspaceSidebar.svelte?raw";
import sidebarViewModelSource from "../app/desktop-sidebar-view-model.svelte.ts?raw";
import navigationSource from "../app/desktop-navigation-view-model-services.ts?raw";

describe("RegistryPanel refresh lifecycle", () => {
  it("marks active session skills without treating availability as project ownership", () => {
    expect(panelSource).toContain("registryItemsWithContext(");
    expect(panelSource).toContain("contextCommands));");
    expect(panelSource).toContain("item.inContext && !item.local");
    expect(panelSource).toContain("item.inContext && item.local");
    expect(panelSource).toContain('title="Available to the active session">In context</span>');
    expect(sidebarSource).toContain("contextCommands={registryContextCommands}");
    expect(sidebarViewModelSource).toContain("registryContextCommands: options.contextCommands?.() ?? []");
    expect(navigationSource).toContain("options.state.runtimeReady && options.state.sessionId");
    expect(navigationSource).toContain("slashCommandsBySession.get(options.state.sessionId)");
  });
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
    expect(panelSource).toContain("registryProjectSyncPresentation(");
    expect(panelSource).toContain("{projectSync.title}");
    expect(panelSource).toContain("{projectSync.description}");
  });

  it("separates reusable resources into Installed and Available views", () => {
    expect(panelSource).toContain('let catalogSection = $state<RegistryCatalogSection>("installed")');
    expect(panelSource).toContain('aria-label="Installed resources"');
    expect(panelSource).toContain('aria-label="Available resources"');
    expect(panelSource).toContain("registryCatalogItems(catalogItems, catalogSection)");
    expect(panelSource).toContain('.filter((item) => item.type !== "project")');
    expect(panelSource).not.toContain('<option value="project">Project</option>');
    expect(panelSource).toContain("onclick={() => item.artifact && onOpenProjectArtifact(item.artifact)}");
  });

  it("keeps Installed usable without a shared registry or project-sync initialization", () => {
    expect(panelSource).toContain('!snapshot.configured && catalogSection === "available"');
    expect(panelSource).toContain("Shared registry is not connected");
    expect(panelSource).toContain("Project sync is not initialized");
    expect(panelSource).not.toContain('{#if projectInitialized === false}\n      <div class="px-3 py-6 text-center">');
  });

  it("displays tags and installation separately from publication", () => {
    expect(panelSource).toContain("item.tags?.length");
    expect(panelSource).toContain("{registryPublicationBadge(item)}");
    expect(panelSource).toContain('action === "tags"');
    expect(panelSource).toContain('action === "make-local"');
  });

  it("shows routine project changes as automatic sync but preserves review actions on errors", () => {
    expect(sidebarSource).toContain("backgroundSync={registryBackgroundSync}");
    expect(panelSource).toContain("registryProjectSyncPresentation(projectItems, backgroundSync, snapshot?.error, projectKeyRequired)");
    expect(panelSource).toContain("{projectSync.title}");
    expect(panelSource).toContain("!projectSync.needsReview");
    expect(panelSource).toContain("automaticPush ? undefined : registryPrimaryAction(item)");
    expect(panelSource).toContain("Auto sync");
  });
});

describe("RegistryPanel catalog row layout", () => {
  const catalogRow = panelSource.match(/<article\b[\s\S]*?<\/article>/)?.[0] ?? "";
  const titleRow = catalogRow.split('data-registry-row="title"')[1]?.split('data-registry-row="description"')[0] ?? "";
  const descriptionRow = catalogRow.split('data-registry-row="description"')[1]?.split('data-registry-row="footer"')[0] ?? "";
  const footerRow = catalogRow.split('data-registry-row="footer"')[1] ?? "";

  it("orders title/type, description, and status/actions into three rows", () => {
    expect(catalogRow).toBeTruthy();
    expect(catalogRow.match(/data-registry-row="[^"]+"/g)).toEqual([
      'data-registry-row="title"',
      'data-registry-row="description"',
      'data-registry-row="footer"',
    ]);
    expect(titleRow).toContain("{item.name}");
    expect(titleRow).toContain("{typeLabel(item.type)}");
    expect(titleRow).not.toContain("registryFriendlyStatusLabel");
    expect(titleRow).not.toContain("<button");
    expect(descriptionRow).toContain("{item.description}");
    expect(titleRow).toContain("item.tags.map");
    expect(titleRow.indexOf("{typeLabel(item.type)}")).toBeLessThan(titleRow.indexOf("item.tags.map"));
    expect(descriptionRow).not.toContain("item.tags");
    expect(footerRow).toContain("{registryFriendlyStatusLabel(item)}");
    expect(footerRow).toContain("{registryPublicationBadge(item)}");
    expect(footerRow).toContain('title={publicationTitle(item)}');
    expect(footerRow).toContain("onclick={() => openItemDiff(item)}");
    expect(footerRow).toContain("onclick={() => runItemAction(item, action)}");
  });

  it("uses item spacing rather than status-colored divider lines", () => {
    expect(panelSource).toContain('<div class="min-w-0 space-y-2">');
    expect(catalogRow).not.toContain("border-l-");
    expect(panelSource).not.toContain("statusBorderTone");
  });

  it("reserves the description row and keeps labels truncatable beside fixed controls", () => {
    expect(catalogRow).toContain("min-h-3.5 min-w-0");
    expect(descriptionRow).toContain('class="min-w-0 flex-1 truncate"');
    expect(titleRow).toContain('title={item.tags.join(", ")}');
    expect(footerRow).toContain("min-w-0 truncate text-xs font-semibold");
    expect(footerRow).toContain('title={statusTitle(item)}');
    expect(footerRow).toContain('class="flex shrink-0 items-center gap-0.5"');
    expect(footerRow).toContain("aria-label={`${scopeSetupRequired ? PROJECT_SCOPE_SETUP_HINT : actionLabel}: ${item.name}`}");
  });
});

describe("RegistryPanel publication scope toggle", () => {
  it("badges published rows with their visibility scope", () => {
    expect(panelSource).toContain("{registryPublicationBadge(item)}");
    expect(panelSource).toContain('title={publicationTitle(item)}');
    expect(panelSource).toContain('"Published to the shared Git registry for this project only"');
    expect(panelSource).toContain('"Published to the shared Git registry for every project"');
  });

  it("offers the backend-provided toggle-scope action with destination-aware icon", () => {
    expect(panelSource).toContain('action === "toggle-scope"');
    expect(panelSource).toContain("registryScopeToggleDestination(item)");
    expect(panelSource).toContain('<Globe class="h-3.5 w-3.5" aria-hidden="true" />');
    expect(panelSource).toContain('<FolderGit2 class="h-3.5 w-3.5" aria-hidden="true" />');
  });

  it("blocks moving a publication to project scope until a project key exists", () => {
    expect(panelSource).toContain("scopeToggleBlocked(item, action)");
    expect(panelSource).toContain("!snapshot?.projectKey");
    expect(panelSource).toContain("disabled={remoteBusy || scopeSetupRequired}");
    expect(panelSource).toContain("PROJECT_SCOPE_SETUP_HINT");
    expect(panelSource).toContain('set one with "Set project key" in the Project sync section');
  });

  it("sends the toggle through the shared per-item action request", () => {
    expect(panelSource).toContain("return { action, type: item.type, name: item.name };");
  });
});

describe("RegistryPanel resource diff", () => {
  it("offers Diff beside item actions only for changed resources with both copies", () => {
    expect(panelSource).toContain("registryDiffAvailable(item) || item.actions.length > 0");
    expect(panelSource).toContain("registryDiffAvailable(item)");
    expect(panelSource).toContain("Compare registry and local copies: ${item.name}");
    expect(panelSource).toContain("onclick={() => openItemDiff(item)}");
    expect(panelSource).toContain("data-registry-diff-trigger={item.id}");
  });

  it("swaps the catalog for an in-panel diff view with close and retry wiring", () => {
    expect(panelSource).toContain("<RegistryDiffPanel");
    expect(panelSource).toContain("onClose={onCloseDiff}");
    expect(panelSource).toContain("onRetry={() => retryDiff(diffState.target)}");
    expect(diffPanelSource).toContain('aria-label="Close registry diff"');
    expect(diffPanelSource).toContain("Try again");
  });

  it("labels the registry copy as the old side and the local copy as the new side", () => {
    expect(diffPanelSource).toContain("Registry → Local");
    expect(diffPanelSource).toContain("old side is the registry copy");
    expect(diffPanelSource).toContain("the new side is the local project copy");
    expect(diffPanelSource).toContain("Added locally");
    expect(diffPanelSource).toContain("Removed locally");
  });

  it("renders a read-only file-by-file diff reusing DiffView and structuredDiffModel", () => {
    expect(diffPanelSource).toContain("import { structuredDiffModel }");
    expect(diffPanelSource).toContain("<DiffView model={structuredDiffModel(");
    expect(diffPanelSource).toContain("newText: file.newText ?? \"\"");
    expect(diffPanelSource).toContain("Read-only comparison");
    expect(diffPanelSource).not.toContain("onApply");
    expect(diffPanelSource).not.toContain("onPull");
    expect(diffPanelSource).not.toContain("onPush");
  });

  it("keeps binary and oversized files visible as notices", () => {
    expect(diffPanelSource).toContain("{#if file.notice}");
    expect(diffPanelSource).toContain("{file.notice}");
  });

  it("keeps loading, error and empty states distinct", () => {
    expect(diffPanelSource).toContain('diff.phase === "loading"');
    expect(diffPanelSource).toContain("Loading diff for");
    expect(diffPanelSource).toContain('role="status"');
    expect(diffPanelSource).toContain('diff.phase === "error"');
    expect(diffPanelSource).toContain('role="alert"');
    expect(diffPanelSource).toContain("{diff.error}");
    expect(diffPanelSource).toContain("No differences between the registry and local copies.");
  });

  it("closes on Escape and restores focus to the trigger", () => {
    expect(diffPanelSource).toContain('if (event.key !== "Escape") return;');
    expect(diffPanelSource).toContain("event.stopPropagation();");
    expect(diffPanelSource).toContain("closeButton?.focus();");
    expect(panelSource).toContain('data-registry-diff-trigger="${CSS.escape(triggerId)}"');
    expect(panelSource).toContain("?.focus();");
  });

  it("wires the diff through the sidebar view model and store", () => {
    expect(sidebarSource).toContain("diff={registryDiff}");
    expect(sidebarSource).toContain("onDiff={onRegistryDiff}");
    expect(sidebarSource).toContain("onCloseDiff={onRegistryCloseDiff}");
    expect(sidebarViewModelSource).toContain("registryDiff: options.registry.diff,");
    expect(sidebarViewModelSource).toContain("onRegistryDiff: options.registry.openDiff,");
    expect(sidebarViewModelSource).toContain("onRegistryCloseDiff: options.registry.closeDiff,");
  });
});
