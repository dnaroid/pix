<script lang="ts">
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Database from "@lucide/svelte/icons/database";
  import Play from "@lucide/svelte/icons/play";
  import StepForward from "@lucide/svelte/icons/step-forward";
  import Square from "@lucide/svelte/icons/square";
  import Settings from "@lucide/svelte/icons/settings";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import SearchIndexHistory from "./SearchIndexHistory.svelte";
  import { indexActionLabel, indexOutcomeLabel, indexResultDetail, type IndexActionState } from "../lib/search-index-actions";
  import type { SearchIndexController, SearchIndexViewState } from "../lib/search-index-controller";
  import { SETTINGS_SEARCH_CATALOG } from "../lib/settings-search-catalog";
  import { SNAPSHOT_LABEL } from "../lib/search-index-freshness";
  import {
    buildSearchSourceRows,
    SEARCH_LOCAL_LABEL,
    SEARCH_SEMANTIC_LABEL,
    type SearchSourceRow,
  } from "../lib/search-index-status";

  let {
    view,
    controller,
    connected = false,
    onSettings,
  }: {
    view: SearchIndexViewState;
    controller: SearchIndexController | null;
    connected?: boolean;
    onSettings?: () => void;
  } = $props();

  const snapshot = $derived(view.snapshot);
  const actions = $derived(view.actions);
  const consent = $derived(snapshot.consent);
  const canIndex = $derived(Boolean(consent?.configured && (consent.provider !== "openrouter" || consent.keyAvailable)));

  const rows = $derived(buildSearchSourceRows(snapshot.stores, consent, snapshot.activity, SETTINGS_SEARCH_CATALOG.length)
    .sort((a, b) => Number(a.id === "settings") - Number(b.id === "settings")));
  const completedRows = $derived(rows.filter(row => actions[row.id] && !actions[row.id]?.running));
  const tone = (state: string) => state === "error" ? "text-tool-error" : state === "ready" || state === "vectors" ? "text-tool-success" : state === "incomplete" || state === "unavailable" || state === "incompatible" ? "text-tool-warning" : "text-muted-foreground";

  function actionHint(row: SearchSourceRow, action?: IndexActionState): string {
    if (action?.running) return "Stop this manual run; saved batches are retained";
    if (!snapshot.selection?.enabled[row.id]) return "Enable this source for indexing and search";
    if (!canIndex) return "Configure semantic search first";
    if (row.semantic === "incompatible") return "Incompatible cache; separate authorized recovery is required";
    if (row.id !== "code" && row.id !== "knowledge" && !connected) return "Search connection required";
    if (row.semanticActive) return "This source is already indexing";
    return "Index missing or changed content; provider charges may apply";
  }

  $effect(() => {
    const owner = controller;
    owner?.refresh();
    return () => owner?.closePanel();
  });
</script>

<section class="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-sidebar text-sidebar-foreground" aria-label="Search index status">
  <div class="flex h-8 min-w-0 items-center gap-2 border-b border-sidebar-border bg-panel px-2.5">
    <Database class="h-3.5 w-3.5 shrink-0 text-tool-search" aria-hidden="true" />
    <strong class="min-w-0 flex-1 truncate text-xs font-medium text-foreground">Search indexes</strong>
    <button class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" title="Check source changes and re-read index status locally (no embeddings)" aria-label="Refresh index status" disabled={!controller || snapshot.reading} onclick={() => controller?.refresh()}><RefreshCw class={["h-3.5 w-3.5", snapshot.reading ? "animate-spin motion-reduce:animate-none" : ""]} aria-hidden="true" /></button>
  </div>
  <div class="flex min-h-0 min-w-0 flex-col overflow-y-auto p-2.5">
      <div class="shrink-0 space-y-2">
        {#each [snapshot.error, snapshot.consentError, snapshot.activityError, snapshot.selectionError].filter(Boolean) as error}
          <p class="text-xs text-tool-error" role="alert">{error}</p>
        {/each}
        {#if snapshot.error && snapshot.stores}
          <p class="text-xs text-tool-warning" role="status">Showing last read counts{snapshot.storesCheckedAt ? ` (${new Date(snapshot.storesCheckedAt).toLocaleTimeString()})` : ""}. Retrying automatically.</p>
        {/if}
        <table class="w-full table-fixed text-left text-xs">
          <thead><tr class="border-b border-sidebar-border text-muted-foreground"><th class="w-[32%] py-2 font-normal">Source</th><th class="w-[24%] py-2 font-normal">Local cache</th><th class="py-2 font-normal">Semantic</th><th class="w-8"><span class="sr-only">Index actions</span></th></tr></thead>
          <tbody>
          {#each rows as row (row.id)}
            {@const action = actions[row.id]}
            {@const actionLabel = indexActionLabel(action)}
            {@const sharedState = snapshot.freshness?.[row.id]?.runState}
            {@const active = (snapshot.selection?.enabled[row.id] ?? false) && (row.semanticActive || action?.running || sharedState === "running" || sharedState === "stopping")}
            {@const detail = indexResultDetail(action) ?? row.semanticDetail}
            {@const enabled = snapshot.selection?.enabled[row.id] ?? false}
            {@const selectionKnown = Boolean(snapshot.selection)}
            {@const loadingCounts = !snapshot.stores && snapshot.reading && !snapshot.error}
            {@const freshness = snapshot.freshness?.[row.id]}
            {@const freshnessDetail = `${freshness?.detail ?? "Snapshot coverage and changes have not been checked."}${freshness?.checkedAt ? ` Last metadata check: ${new Date(freshness.checkedAt).toLocaleString()}.` : ""}`}
            <tr class="border-b border-sidebar-border/70" data-source={row.id}>
              <th scope="row" class="py-3 pr-2 font-medium text-foreground">
                <label class="flex h-4 min-w-0 items-center gap-1.5 leading-4" title={row.id === "settings" ? "Include Settings in indexing and search for all projects" : "Include in indexing and search for this project"}>
                  <input type="checkbox" class="h-3.5 w-3.5 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-ring" checked={enabled} disabled={!controller || !snapshot.selection || Boolean(view.savingSource)} aria-label={`Include ${row.label} in indexing and search${row.id === "settings" ? " for all projects" : ""}`} onchange={event => void controller?.setSource(row.id, event.currentTarget.checked)} />
                  <span class="truncate">{row.label}</span>
                </label>
              </th>
              <td class="py-3 pr-2" title={`${row.localDetail} ${freshnessDetail}`}><span class="flex h-8 min-w-0 flex-col justify-center overflow-hidden whitespace-nowrap leading-4"><span class={["truncate", snapshot.error && snapshot.stores ? "text-tool-warning" : tone(row.local)]}>{loadingCounts && row.id !== "settings" ? "Checking…" : row.localSummary ?? SEARCH_LOCAL_LABEL[row.local]}</span><span class={["truncate", !enabled || active ? "text-muted-foreground" : freshness?.state === "changed" ? "text-tool-warning" : freshness?.state === "current" && freshness.coverage === "complete" ? "text-tool-success" : "text-muted-foreground"]} aria-label={`${row.label} snapshot freshness`}>{selectionKnown && !enabled ? "Off" : active ? "Indexing" : !freshness && snapshot.reading ? "Checking…" : SNAPSHOT_LABEL[freshness?.state ?? "unchecked"]}</span></span></td>
              <td class="py-3" title={`${detail}${row.storedVectors !== undefined ? ` · ${row.storedVectors.toLocaleString("en-US")} stored vectors (retained cache, not proof of current coverage)` : ""}`} aria-busy={active ?? false}>
                <span class="flex h-8 min-w-0 flex-col justify-center overflow-hidden leading-4">
                <span class="flex min-w-0 items-center gap-1 whitespace-nowrap" aria-live="polite">
                  {#if !selectionKnown || loadingCounts}
                    <span class="truncate text-muted-foreground">{snapshot.reading ? "Checking…" : "Unavailable"}</span>
                  {:else if !enabled}
                    <span class="truncate text-muted-foreground" title="Disabled for indexing and search; existing cache retained">Off</span>
                  {:else if active}
                    <svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <circle class="text-muted-foreground/30" cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" />
                      <circle class="origin-center animate-spin text-tool-search motion-reduce:animate-none" cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="10 28" />
                    </svg>
                    <span class="truncate text-tool-search" aria-label={`${action?.stopping || sharedState === "stopping" ? "Stopping" : "Indexing"} ${row.label}`}>{action?.stopping || sharedState === "stopping" ? "Stopping" : "Indexing"}</span>
                  {:else}
                    <span class={["truncate", action?.error ? "text-tool-error" : action?.result && !action.result.complete ? "text-tool-warning" : tone(row.semantic)]}>
                      {indexOutcomeLabel(action) ?? SEARCH_SEMANTIC_LABEL[row.semantic]}
                    </span>
                  {/if}
                </span>
                {#if enabled && !active}
                  <span class="truncate text-muted-foreground" title={freshnessDetail}>{freshness?.coverage === "complete" ? "Last pass full" : freshness?.coverage === "partial" ? "Last pass partial" : freshness?.state === "untracked" ? "No recorded pass" : snapshot.reading && !freshness ? "Checking…" : "Pass unverified"}</span>
                {/if}
                </span>
              </td>
              <td class="py-2 pl-1 text-right">
                {#if !row.empty || action?.running}
                <button type="button"
                  class="ml-auto grid h-6 w-6 place-items-center rounded text-tool-search hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:text-muted-foreground disabled:opacity-40"
                  aria-label={`${actionLabel} ${row.label}`}
                  title={`${actionLabel} ${row.label}: ${actionHint(row, action)}`}
                  disabled={!controller || (!action?.running && (!enabled || Boolean(view.savingSource) || Boolean(active) || !canIndex || (row.id !== "code" && row.id !== "knowledge" && !connected) || row.semantic === "incompatible"))}
                  onclick={() => action?.running ? controller?.cancel(row.id) : controller?.start(row.id)}
                >
                  {#if actionLabel === "Stop"}
                    <Square class="h-3.5 w-3.5" aria-hidden="true" />
                  {:else if actionLabel === "Continue"}
                    <StepForward class="h-3.5 w-3.5" aria-hidden="true" />
                  {:else}
                    <Play class="h-3.5 w-3.5" aria-hidden="true" />
                  {/if}
                </button>
                {/if}
              </td>
            </tr>
          {/each}
          </tbody>
        </table>
        <div class="flex items-center gap-2 pt-2 text-xs"><span class="font-medium">Semantic search</span><span class="text-muted-foreground">{!consent ? "Unavailable" : !consent.configured ? "Off" : consent.provider === "openrouter" && !consent.keyAvailable ? "Needs API key" : "On"}</span><button type="button" onclick={onSettings} aria-label="Configure semantic search" title="Configure semantic search: Embedding model" class="ml-auto grid h-6 w-6 place-items-center rounded text-tool-search hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"><Settings class="h-3.5 w-3.5" aria-hidden="true" /></button></div>
        {#if completedRows.length}
          <details class="group text-xs text-muted-foreground">
            <summary class="flex cursor-pointer list-none items-center gap-1 rounded py-1 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
              Last runs
            </summary>
            <div class="space-y-1 pt-1">
              {#each completedRows as row (row.id)}
                <p>{row.label}: {indexResultDetail(actions[row.id])}</p>
              {/each}
            </div>
          </details>
        {/if}
      </div>
      <SearchIndexHistory events={view.history} onClear={controller ? () => controller.clearHistory() : undefined} />
  </div>
</section>
