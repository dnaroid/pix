import { describe, expect, it } from "vitest";
import panel from "./SearchIndexPanel.svelte?raw";
import sidebar from "./WorkspaceSidebar.svelte?raw";
import monitor from "../lib/search-index-monitor.ts?raw";
import controller from "../lib/search-index-controller.ts?raw";
import transport from "../lib/workspace-search-index-controller.ts?raw";
import owner from "../lib/workspace-search-index-owner.svelte.ts?raw";
import history from "./SearchIndexHistory.svelte?raw";

describe("SearchIndexPanel source contract", () => {
  it("fills available height and follows chronological events without pulling readers from history", () => {
    expect(panel).toContain('flex min-h-0 min-w-0 flex-col overflow-y-auto');
    expect(history).toContain("min-h-32 min-w-0 flex-1 flex-col");
    expect(history).not.toContain("max-h-64");
    expect(history).toContain("{#each events as event (event.id)}");
    expect(history).toContain("$effect.pre");
    expect(history).toContain("createHistoryScrollTracker(viewport)");
    expect(history).toContain("if (active) tracker.restore(position)");
    expect(history).toContain("resize.observe(list)");
    expect(history).toContain("resize.disconnect()");
  });
  it("is mounted as the native search status tab", () => {
    expect(sidebar).toContain("<SearchIndexPanel");
    expect(sidebar).not.toContain("<IdxPanel");
    expect(sidebar).toContain('activeTab === "search"');
    expect(panel).not.toMatch(/idx|IDX/);
  });
  it("separates read-only status from explicit indexing and guards stale refreshes", () => {
    expect(transport).toContain('"search_index_status"');
    expect(transport).toContain('"native_repository_semantic_config"');
    expect(panel).not.toMatch(/idx_operation_start|startOperation/);
    expect(monitor).toContain("request === generation");
    expect(transport).toContain("client.searchIndex");
    expect(transport).toContain("indexNativeRepository");
    expect(controller).toContain("indexing.dispose()");
    expect(panel).toContain("owner?.closePanel()");
    expect(panel).not.toContain("monitorSearchIndexes");
    expect(panel).not.toContain("Stored means saved vectors, not verified coverage");
    expect(panel).not.toContain("Status checks every 30 seconds when idle");
    expect(panel).toContain("<SearchIndexHistory events={view.history}");
    expect(history).toContain('aria-label="Recent index events"');
    expect(history).toContain("events.length}/200");
  });
  it("collapses last runs and spins only active sources, not refreshed cells", () => {
    expect(panel).toContain("<table");
    expect(panel).toContain('<details class="group');
    expect(panel).not.toMatch(/<details[^>]*\bopen\b/);
    expect(panel).toContain("<ChevronRight");
    expect(panel).toContain("group-open:rotate-90");
    expect(panel).toContain("Last runs");
    expect(panel).toContain("{#if !row.empty || action?.running}");
    expect(panel).not.toContain("{#if loading}");
    expect(panel).toContain("row.semanticActive || action?.running");
    expect(panel).not.toContain("action?.queued");
    expect(panel).toContain("{#if active}");
    expect(panel.match(/<LoaderCircle/g)).toHaveLength(1);
    expect(panel).toContain("<LoaderCircle");
    expect(panel.match(/flex h-4 min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap leading-4/g)).toHaveLength(2);
    expect(panel).not.toContain("inline-flex");
    expect(transport).toContain('window.removeEventListener("pix-semantic-config-changed", controller.configChanged)');
    expect(controller).toContain("monitor.dispose()");
    expect(panel).toContain("$effect(() =>");
    expect(panel).not.toContain("States below are unknown");
  });
  it("syncs the authored catalogue for the workspace even while Settings is closed", () => {
    expect(owner).toContain("startSearchIndexSync(connection, selected, SETTINGS_SEARCH_CATALOG");
    expect(sidebar).toContain("view={searchIndexes} controller={searchIndexController}");
    expect(sidebar).toContain("createWorkspaceSearchIndexOwner");
    expect(owner).toContain("createWorkspaceSearchIndexController(selected, connection");
  });
  it("uses labelled icon-only actions without truncating command text", () => {
    expect(panel).toContain('const actionLabel = indexActionLabel(action)');
    expect(panel).toContain('aria-label={`${actionLabel} ${row.label}`}');
    expect(panel).toContain('title={`${actionLabel} ${row.label}: ${actionHint(row, action)}`}');
    expect(panel).toContain('{#if actionLabel === "Stop"}');
    expect(panel).toContain('{:else if actionLabel === "Continue"}');
    for (const icon of ["Play", "StepForward", "Square", "Settings"]) {
      expect(panel).toContain(`<${icon} class="h-3.5 w-3.5" aria-hidden="true" />`);
    }
    expect(panel).not.toContain('>{indexActionLabel(action)}</button>');
    expect(panel).not.toContain('>Settings</button>');
    expect(panel).toContain('aria-label="Configure semantic search"');
    expect(panel).toContain('title="Configure semantic search: Embedding model"');
  });
});
