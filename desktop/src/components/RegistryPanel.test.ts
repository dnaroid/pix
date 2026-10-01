import { describe, expect, it } from "vitest";
import panelSource from "./RegistryPanel.svelte?raw";
import projectStatusSource from "./RegistryProjectStatus.svelte?raw";
import catalogSource from "./RegistryCatalog.svelte?raw";
import statusIconSource from "./RegistryStatusIcon.svelte?raw";
import actionsSource from "./RegistryItemActions.svelte?raw";
import diffPanelSource from "./RegistryDiffPanel.svelte?raw";
import sidebarSource from "./WorkspaceSidebar.svelte?raw";
import sidebarViewModelSource from "../app/desktop-sidebar-view-model.svelte.ts?raw";
import navigationSource from "../app/desktop-navigation-view-model-services.ts?raw";
import registrySource from "../lib/registry.ts?raw";

describe("RegistryPanel orchestrator", () => {
  it("composes project status, catalog and diff view without owning their markup", () => {
    expect(panelSource).toContain("<RegistryProjectStatus");
    expect(panelSource).toContain("<RegistryCatalog");
    expect(panelSource).toContain("<RegistryDiffPanel");
    expect(panelSource).not.toContain("registryItemsWithContext(");
    expect(panelSource).not.toContain(".pi storage");
  });

  it("restores focus to the Diff trigger that opened the closed diff view", () => {
    expect(panelSource).toContain("lastDiffTriggerId = item.id");
    expect(panelSource).toContain('data-registry-diff-trigger="${CSS.escape(triggerId)}"');
    expect(panelSource).toContain("?.focus();");
    expect(panelSource).toContain("onRetry={() => retryDiff(diffState.target)}");
  });

  it("wires the diff through the sidebar view model and store", () => {
    expect(sidebarSource).toContain("diff={registryDiff}");
    expect(sidebarSource).toContain("onDiff={onRegistryDiff}");
    expect(sidebarSource).toContain("onCloseDiff={onRegistryCloseDiff}");
    expect(sidebarViewModelSource).toContain("registryDiff: options.registry.diff,");
    expect(sidebarViewModelSource).toContain("onRegistryDiff: options.registry.openDiff,");
    expect(sidebarViewModelSource).toContain("onRegistryCloseDiff: options.registry.closeDiff,");
  });

  it("does not gate Registry controls on conversation session readiness", () => {
    expect(sidebarSource).toContain("remoteDisabled={!registryReady}");
    expect(sidebarSource).not.toContain("disabled={!sessionReady || registryActionId !== null}");
  });
});

describe("RegistryProjectStatus quiet-by-default sync row", () => {
  it("stays a single status line in the common case and expands only for genuine review states", () => {
    expect(projectStatusSource).toContain("registryProjectSyncPresentation(");
    expect(projectStatusSource).toContain("{projectSync.title}");
    expect(projectStatusSource).toContain("{projectSync.description}");
    expect(projectStatusSource).toContain('item.status !== "up-to-date" && item.status !== "local-only" && item.status !== "local-changes"');
    expect(projectStatusSource).toContain("const expanded = $derived(projectSync.needsReview && attentionItems.length > 0);");
    expect(projectStatusSource).not.toContain("projectReviewOpen");
    expect(projectStatusSource).not.toContain("ChevronDown");
  });

  it("keeps project-sync initialization separate from remote registry configuration", () => {
    expect(projectStatusSource).toContain("projectInitialized === false");
    expect(projectStatusSource).toContain("Project sync is not initialized");
    expect(projectStatusSource).toContain("onclick={onInitializeProject}");
    expect(projectStatusSource).toContain('actionId === "initialize-project"');
  });

  it("moves .pi storage and cleanup into a compact housekeeping menu instead of a permanent row", () => {
    expect(projectStatusSource).toContain("Project housekeeping");
    expect(projectStatusSource).toContain("aria-haspopup=\"menu\"");
    expect(projectStatusSource).toContain("storageSummary()");
    expect(projectStatusSource).toContain("projectPiCleanupAvailable");
    expect(projectStatusSource).toContain('actionId === "cleanup-project"');
    expect(projectStatusSource).toContain("window.confirm");
    expect(projectStatusSource).toContain("clears all contents of artifacts/ and subagents/");
    expect(projectStatusSource).toContain("removes non-canonical top-level files and directories");
    expect(projectStatusSource).toContain("Canonical project state, config, agents/, plans/, skills/ and task-attachments/ are preserved");
    expect(projectStatusSource).toContain("onCleanProject()");
    expect(projectStatusSource).toContain("Checking… total");
  });

  it("surfaces a required project key inline rather than hiding it in the menu", () => {
    expect(projectStatusSource).toContain("projectKeyRequired");
    expect(projectStatusSource).toContain('onclick={() => onAction({ action: "project-key" }, "project-key")}');
  });

  it("shows routine project changes as automatic sync but keeps review items visible on errors", () => {
    expect(sidebarSource).toContain("backgroundSync={registryBackgroundSync}");
    expect(projectStatusSource).toContain("registryProjectSyncPresentation(projectItems, backgroundSync, snapshot?.error, projectKeyRequired)");
    expect(projectStatusSource).toContain("registryPrimaryAction(item)");
  });
});

describe("RegistryCatalog", () => {
  it("marks active session skills without treating availability as project ownership", () => {
    expect(catalogSource).toContain("registryItemsWithContext(");
    expect(catalogSource).toContain("contextCommands));");
    expect(catalogSource).toContain("item.inContext && !item.local");
    expect(catalogSource).toContain("item.inContext && item.local");
    expect(catalogSource).toContain('title="Available to the active session">In context</span>');
    expect(sidebarSource).toContain("contextCommands={registryContextCommands}");
    expect(sidebarViewModelSource).toContain("registryContextCommands: options.contextCommands?.() ?? []");
    expect(navigationSource).toContain("options.state.runtimeReady && options.state.sessionId");
    expect(navigationSource).toContain("slashCommandsBySession.get(options.state.sessionId)");
  });

  it("separates reusable resources into Installed and Available views", () => {
    expect(catalogSource).toContain('let catalogSection = $state<RegistryCatalogSection>("installed")');
    expect(catalogSource).toContain('aria-label="Installed resources"');
    expect(catalogSource).toContain('aria-label="Available resources"');
    expect(catalogSource).toContain("registryCatalogItems(catalogItems, catalogSection)");
    expect(catalogSource).toContain('.filter((item) => item.type !== "project")');
    expect(catalogSource).not.toContain('<option value="project">Project</option>');
  });

  it("keeps Installed usable without a shared registry or project-sync initialization", () => {
    expect(catalogSource).toContain('!snapshot.configured && catalogSection === "available"');
    expect(catalogSource).toContain("Shared registry is not connected");
  });

  it("displays tags as chips in their own row, separate from publication", () => {
    expect(catalogSource).toContain("item.tags?.length");
    expect(catalogSource).toContain('data-registry-row="tags"');
    expect(catalogSource).toContain("visibleTags(item)");
    expect(catalogSource).toContain("hiddenTagCount(item)");
    expect(catalogSource).toContain("<RegistryItemActions");
    expect(actionsSource).toContain("{#each actions.secondary as action}");
  });

  it("shows publication scope as a compact icon with a descriptive tooltip", () => {
    expect(catalogSource).toContain("publicationIcon(item)");
    expect(catalogSource).toContain("publicationLabel(item)");
    expect(catalogSource).toContain('title={publicationTitle(item)}');
    expect(catalogSource).not.toContain("registryPublicationBadge");
    expect(catalogSource).toContain('"Published to the shared Git registry for this project only"');
    expect(catalogSource).toContain('"Published to the shared Git registry for every project"');
  });

  it("shows resource type as a colored icon instead of a text badge", () => {
    expect(catalogSource).toContain("typeIcon(item.type)");
    expect(catalogSource).toContain("typeTone(item.type)");
    expect(catalogSource).not.toContain("font-mono text-xs font-semibold tracking-wide");
  });

  it("sends the toggle through the shared per-item action request", () => {
    expect(catalogSource).toContain('return { action, type: item.type as "skill" | "agent", name: item.name };');
  });

  it("offers Diff beside item actions only for changed resources with both copies", () => {
    expect(catalogSource).toContain("registryDiffAvailable(item) || item.actions.length > 0");
    expect(catalogSource).toContain("registryDiffAvailable(item)");
    expect(actionsSource).toContain("Compare registry and local copies: ${item.name}");
    expect(catalogSource).toContain("onDiff={() => onDiff(item)}");
    expect(actionsSource).toContain("data-registry-diff-trigger={item.id}");
  });

  it("reuses the shared RegistryStatusIcon instead of duplicating the status switch", () => {
    expect(catalogSource).toContain("<RegistryStatusIcon");
    expect(catalogSource).toContain("registryStatusTone(item.status, item.inContext && !item.local)");
  });
});

describe("RegistryStatusIcon", () => {
  it("maps every registry status to one icon shared by project-status and catalog rows", () => {
    for (const status of [
      "up-to-date", "update-available", "local-changes", "diverged", "not-installed",
      "local-only", "untracked-local", "missing-local", "removed-remote", "registry-changed",
    ]) {
      expect(statusIconSource).toContain(status === "up-to-date" ? 'status === "up-to-date"' : `"${status}"`);
    }
    expect(projectStatusSource).toContain("<RegistryStatusIcon");
  });
});

describe("registry lib status tone", () => {
  it("exposes a shared status→tone helper used by both rows", () => {
    expect(registrySource).toContain("export function registryStatusTone(");
    expect(catalogSource).toContain("registryStatusTone(");
    expect(projectStatusSource).toContain("registryStatusTone(");
  });
});

describe("RegistryPanel catalog row layout", () => {
  const catalogRow = catalogSource.match(/<article\b[\s\S]*?<\/article>/)?.[0] ?? "";
  const titleRow = catalogRow.split('data-registry-row="title"')[1]?.split('data-registry-row="description"')[0] ?? "";
  const descriptionRow = catalogRow.split('data-registry-row="description"')[1]?.split(/data-registry-row="(?:tags|footer)"/)[0] ?? "";
  const footerRow = catalogRow.split('data-registry-row="footer"')[1] ?? "";

  it("orders title/type, description, optional tags, and status/actions into rows", () => {
    expect(catalogRow).toBeTruthy();
    expect(catalogRow.match(/data-registry-row="[^"]+"/g)).toEqual([
      'data-registry-row="title"',
      'data-registry-row="description"',
      'data-registry-row="tags"',
      'data-registry-row="footer"',
    ]);
    expect(titleRow).toContain("{item.name}");
    expect(titleRow).not.toContain("registryFriendlyStatusLabel");
    expect(titleRow).not.toContain("<button");
    expect(descriptionRow).toContain("{item.description}");
    expect(descriptionRow).not.toContain("visibleTags(item)");
    expect(footerRow).toContain("{registryFriendlyStatusLabel(item)}");
    expect(footerRow).toContain("publicationIcon(item)");
    expect(footerRow).toContain('title={publicationTitle(item)}');
    expect(footerRow).toContain("onDiff={() => onDiff(item)}");
    expect(footerRow).toContain("onAction={(action) => runItemAction(item, action)}");
  });

  it("uses item spacing rather than status-colored divider lines", () => {
    expect(catalogSource).toContain('<div class="min-w-0 space-y-2">');
    expect(catalogRow).not.toContain("border-l-");
    expect(catalogSource).not.toContain("statusBorderTone");
  });

  it("reserves the description row and keeps labels truncatable beside fixed controls", () => {
    expect(catalogRow).toContain("min-h-3.5 min-w-0");
    expect(descriptionRow).toContain('class="min-w-0 flex-1 truncate"');
    expect(footerRow).toContain("min-w-0 truncate text-xs font-semibold");
    expect(footerRow).toContain('title={statusTitle(item)}');
    expect(footerRow).toContain("<RegistryItemActions");
    expect(actionsSource).toContain('class="flex shrink-0 items-center gap-0.5"');
    expect(actionsSource).toContain("aria-label={`More actions: ${item.name}`}");
  });
});

describe("RegistryPanel publication scope toggle", () => {
  it("offers the backend-provided visibility toggle in the labeled overflow menu", () => {
    expect(actionsSource).toContain('action === "toggle-scope"');
    expect(actionsSource).toContain("registryScopeToggleDestination(item)");
    expect(actionsSource).toContain("{registryFriendlyActionLabel(item, action)}");
  });

  it("blocks moving a publication to project scope until a project key exists", () => {
    expect(catalogSource).toContain("projectKey={snapshot.projectKey}");
    expect(actionsSource).toContain("!projectKey");
    expect(actionsSource).toContain("disabled={busy || blocked(action)}");
    expect(actionsSource).toContain('set one with "Set project key" in the Project sync section');
  });
});

describe("RegistryPanel resource diff", () => {
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
  });
});

describe("Registry resource-card overflow", () => {
  it("uses vertical dots and decorative icons beside every menu label", () => {
    expect(actionsSource).toContain('icons/ellipsis-vertical');
    expect(actionsSource).toContain('<EllipsisVertical ');
    expect(actionsSource).not.toContain('<Ellipsis ');
    expect(actionsSource).toContain('satisfies Record<RegistryItemAction, typeof Upload>');
    expect(actionsSource).toContain('"toggle-scope": FolderGit2');
    expect(actionsSource).toContain('? Globe : actionIcons[action]');
    const menu = actionsSource.split('{#if open}')[1]!;
    expect(menu).toContain('<Icon class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />');
    expect(menu.indexOf('<Icon ')).toBeLessThan(menu.indexOf('{registryFriendlyActionLabel(item, action)}'));
  });
  it("renders only the selected primary plus Compare outside the labeled menu", () => {
    const direct = actionsSource.split("{#if open}")[0]!;
    expect(direct).toContain("{#if actions.primary}");
    expect(direct).toContain("registryDiffAvailable(item)");
    expect(direct).not.toContain("{#each item.actions");
    expect(actionsSource).toContain('aria-haspopup="menu" aria-expanded={open}');
    expect(actionsSource).toContain('role="menuitem" tabindex="-1"');
    expect(actionsSource).toContain("{#each actions.secondary as action}");
    expect(actionsSource).toContain("close(true); onAction(action);");
  });
  it("uses shared menu navigation and restores invoker focus without trapping Tab", () => {
    expect(actionsSource).toContain("menuFocusIndex(navigationItems()");
    expect(actionsSource).toContain("menuTypeaheadFocusIndex(navigationItems()");
    expect(actionsSource).toContain('if (event.key === "Escape")');
    expect(actionsSource).toContain('if (event.key === "Tab") { close(true); return; }');
    expect(actionsSource).toContain('void show(event.key === "ArrowUp")');
    expect(actionsSource).toContain("if (restoreFocus) trigger?.focus()");
  });
  it("escapes scroll clipping, cleans listeners/portal, and cancels deferred opening", () => {
    expect(actionsSource).toContain("document.body.appendChild(node)");
    expect(actionsSource).toContain("destroy: () => node.remove()");
    expect(actionsSource).toContain("registryMenuPosition(trigger.getBoundingClientRect()");
    expect(actionsSource).toContain("request !== generation");
    for (const event of ["pointerdown", "focusin", "scroll", "resize"]) {
      expect(actionsSource).toContain(`addEventListener("${event}"`);
      expect(actionsSource).toContain(`removeEventListener("${event}"`);
    }
  });
});
