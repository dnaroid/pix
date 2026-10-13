import { describe, expect, it } from "vitest";
import panel from "./SearchIndexPanel.svelte?raw";
import sidebar from "./WorkspaceSidebar.svelte?raw";
import monitor from "../lib/search-index-monitor.ts?raw";
import controller from "../lib/search-index-controller.ts?raw";
import transport from "../lib/workspace-search-index-controller.ts?raw";
import owner from "../lib/workspace-search-index-owner.svelte.ts?raw";
import history from "./SearchIndexHistory.svelte?raw";

describe("SearchIndexPanel source contract", () => {
  it("keeps Settings last with a global checkbox and project-local controls for other sources", () => {
    expect(panel).toContain('.sort((a, b) => Number(a.id === "settings") - Number(b.id === "settings"))');
    expect(panel).toContain('Include Settings in indexing and search for all projects');
    expect(panel).toContain('controller?.setSource(row.id, event.currentTarget.checked)');
    expect(panel).not.toContain('{#if row.id === "settings"}');
    expect(panel).not.toContain('Counts show cached entities');
    expect(panel).not.toContain('Last pass coverage and source changes are separate');
  });
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
  it("opts the activity log into native text selection and copy", () => {
    expect(history).toMatch(/<div[^>]*class="select-text [^"]*"[^>]*aria-label="Recent index events"/);
    expect(history).not.toContain("oncopy=");
    expect(history).not.toContain("onselectstart=");
  });
  it("wires an accessible icon-only clear button to workspace history", () => {
    expect(history).toContain('aria-label="Clear index activity log"');
    expect(history).toContain('title="Clear index activity log"');
    expect(history).toContain('<Trash2 class="h-3.5 w-3.5" aria-hidden="true" />');
    expect(history).toContain('disabled={!onClear || events.length === 0} onclick={onClear}');
    expect(panel).toContain('onClear={controller ? () => controller.clearHistory() : undefined}');
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
    expect(panel).toContain("{:else if active}");
    expect(panel).not.toContain("LoaderCircle");
    expect(panel).toContain("flex h-8 min-w-0 flex-col justify-center overflow-hidden leading-4");
    expect(panel).not.toContain("inline-flex");
    expect(transport).toContain('window.removeEventListener("pix-semantic-config-changed", configChanged)');
    expect(controller).toContain("monitor.dispose()");
    expect(panel).toContain("$effect(() =>");
    expect(panel).not.toContain("States below are unknown");
  });
  it("shows visible indexing/stopping and retained counts without inventing coverage", () => {
    expect(panel).toContain('viewBox="0 0 16 16" fill="none" aria-hidden="true"');
    expect(panel).toContain('class="text-muted-foreground/30"');
    expect(panel).toContain('origin-center animate-spin text-tool-search motion-reduce:animate-none');
    expect(panel).toContain('stroke-linecap="round" stroke-dasharray="10 28"');
    expect(panel).toContain('action?.stopping || sharedState === "stopping" ? "Stopping" : "Indexing"');
    expect(panel).toContain('row.storedVectors.toLocaleString("en-US")} stored');
    expect(panel).toContain('retained cache, not proof of current coverage');
    expect(panel).not.toContain('<span class="sr-only">Indexing');
    expect(panel).not.toContain('aria-valuenow');
  });
  it("distinguishes startup, stale counts and missing manual history", () => {
    expect(panel).toContain('!snapshot.stores && snapshot.reading && !snapshot.error');
    expect(panel).toContain('Checking…');
    expect(panel).toContain('snapshot.error && snapshot.stores');
    expect(panel).toContain('Showing last read counts');
    expect(panel).toContain('Retrying automatically.');
    expect(panel).toContain('No recorded pass');
    expect(panel).not.toContain('Coverage unknown');
    expect(panel).toContain('selectionKnown && !enabled');
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
