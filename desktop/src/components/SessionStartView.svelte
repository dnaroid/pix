<script lang="ts">
  import Search from "@lucide/svelte/icons/search";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import { onMount } from "svelte";
  import type { SessionInfo } from "@agentclientprotocol/sdk";
  import { previewInlineSearch, queryInlineSearch, type InlineSearchClient } from "../lib/inline-search";
  import { pendingSearchNotice } from "../lib/search-source-deadline";
  import type { SessionSearchHit } from "../../../acp/src/search/contract";
  import { buildSessionTree, type SessionTreeRow } from "../lib/session-tabs";
  import { expandedSessionRows, flatSessionRow, sessionRowsRelated } from "../lib/saved-session-tree";
  import SavedSessionRow from "./SavedSessionRow.svelte";
  import {
    SAVED_SESSION_INITIAL_ROWS,
    SAVED_SESSION_NEXT_ROWS,
    nextSavedSessionRowCount,
    visibleSavedSessionRows,
  } from "../lib/saved-session-pagination";

  let {
    sessions,
    workspace,
    searchClient = null,
    onSelect,
  }: {
    sessions: readonly SessionInfo[];
    workspace: string;
    searchClient?: InlineSearchClient | null;
    onSelect: (sessionId: string) => void;
  } = $props();

  let query = $state("");
  let searchInput = $state<HTMLInputElement | null>(null);
  let scrollContainer = $state<HTMLDivElement | null>(null);
  let loadMoreTrigger = $state<HTMLButtonElement | null>(null);
  let visibleCount = $state(SAVED_SESSION_INITIAL_ROWS);
  let collapsed = $state(new Set<string>());
  let hoveredId = $state<string | null>(null);
  let focusedId = $state<string | null>(null);
  let submittedHits = $state<SessionSearchHit[] | null>(null);
  let searching = $state(false);
  let searchNotice = $state("");
  let searchRequest: AbortController | null = null;
  const displayedSessions = $derived.by(() => {
    if (!query.trim()) return expandedSessionRows(buildSessionTree(sessions), collapsed);
    const byId = new Map(sessions.map(session => [session.sessionId, session]));
    return (submittedHits ?? previewInlineSearch("sessions", query, sessions)).flatMap(hit => {
      const session = byId.get(hit.sessionId);
      return session ? [flatSessionRow(session)] : [];
    });
  });
  const visibleSessions = $derived(visibleSavedSessionRows(displayedSessions, visibleCount));
  const hasMore = $derived(visibleCount < displayedSessions.length);
  const activeRow = $derived(displayedSessions.find((row) => row.session.sessionId === (hoveredId ?? focusedId)) ?? null);

  function cancelSearch() {
    searchRequest?.abort();
    searchRequest = null;
    submittedHits = null;
    searching = false;
    searchNotice = "";
  }

  async function submitSearch() {
    const submitted = query.trim();
    if (!submitted) return;
    cancelSearch();
    if (!searchClient || !workspace) {
      searchNotice = "Offline: showing local session titles";
      return;
    }
    const request = new AbortController();
    searchRequest = request;
    searching = true;
    const publish = (result: Awaited<ReturnType<typeof queryInlineSearch>>) => {
      if (searchRequest !== request || request.signal.aborted || query.trim() !== submitted) return;
      if (!result.status && !result.results.length && !result.notices.length && !result.pendingSources?.length) return;
      // The global source has no session fallback on backend failure; preserve
      // the already-visible local preview rather than replacing it with empty rows.
      const failed = result.notices.some(notice => notice.startsWith("Sessions search failed:") || notice.startsWith("Session title search is unavailable:"));
      submittedHits = failed || (result.pendingSources?.length && !result.results.length) ? null
        : result.results.filter((hit): hit is SessionSearchHit => hit.kind === "sessions");
      searching = Boolean(result.pendingSources?.length);
      searchNotice = result.notices.find(notice => !(result.pendingSources ?? []).some(source => notice === pendingSearchNotice(source)))
        ?? result.status?.warning ?? result.status?.error ?? "";
    };
    try { publish(await queryInlineSearch("sessions", searchClient, workspace, submitted, request.signal, publish)); }
    catch {
      if (searchRequest === request && !request.signal.aborted) {
        searching = false;
        searchNotice = "Indexed search unavailable; showing local titles";
      }
    }
  }

  function resetPages(): void {
    visibleCount = SAVED_SESSION_INITIAL_ROWS;
    if (scrollContainer) scrollContainer.scrollTop = 0;
  }

  let previousWorkspace: string | undefined;
  $effect(() => {
    const currentWorkspace = workspace;
    if (previousWorkspace === undefined) {
      previousWorkspace = currentWorkspace;
      return;
    }
    if (previousWorkspace === currentWorkspace) return;
    previousWorkspace = currentWorkspace;
    query = "";
    collapsed = new Set();
    hoveredId = null;
    focusedId = null;
    resetPages();
  });

  $effect(() => {
    const ownerWorkspace = workspace;
    const ownerClient = searchClient;
    void ownerWorkspace; void ownerClient;
    return cancelSearch;
  });

  function loadNextPage(): void {
    if (!hasMore) return;
    visibleCount = nextSavedSessionRowCount(visibleCount, displayedSessions.length);
  }

  function toggleBranch(sessionId: string): void {
    const next = new Set(collapsed);
    if (!next.delete(sessionId)) next.add(sessionId);
    collapsed = next;
  }

  function activateRow(row: SessionTreeRow, active: boolean, source: "pointer" | "focus"): void {
    const id = row.session.sessionId;
    if (source === "pointer") {
      if (active || hoveredId === id) hoveredId = active ? id : null;
    } else if (active || focusedId === id) {
      focusedId = active ? id : null;
    }
  }

  // The sentinel moves downward after each page. Observe only the scrollable
  // results pane; changing query/workspace or unmounting disconnects the observer.
  $effect(() => {
    const root = scrollContainer;
    const trigger = loadMoreTrigger;
    if (!root || !trigger || !hasMore || typeof IntersectionObserver === "undefined") return;
    let disconnected = false;
    const observer = new IntersectionObserver((entries) => {
      if (!disconnected && entries.some((entry) => entry.isIntersecting)) loadNextPage();
    }, { root, rootMargin: "0px 0px 96px 0px" });
    observer.observe(trigger);
    return () => { disconnected = true; observer.disconnect(); };
  });

  function displayDate(value: string | null | undefined): string {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.valueOf())
      ? ""
      : date.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
  }

  onMount(() => searchInput?.focus());
</script>

<section class="h-full min-h-0 min-w-0 overflow-hidden px-6 pt-8 pb-3" aria-label="Open saved conversation">
  <div class="mx-auto grid h-full min-h-0 w-full max-w-[620px] grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-y border-border bg-background">
    <header class="shrink-0 bg-background px-2.5 pt-2.5 pb-2">
      <div class="flex items-baseline justify-between gap-3">
        <h2 class="text-xs font-semibold text-foreground">Open a conversation</h2>
        <span class="text-xs text-muted-foreground">or start typing below</span>
      </div>
      <div class="relative mt-2">
        <label for="saved-session-search" class="sr-only">Search saved conversations</label>
        <Search class="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          id="saved-session-search"
          class="h-7 w-full rounded-md border border-input bg-panel-strong pr-24 pl-7 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/25"
          bind:this={searchInput}
          bind:value={query}
          oninput={() => { resetPages(); cancelSearch(); }}
          onkeydown={(event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); void submitSearch(); } }}
          type="search"
          placeholder="Search saved conversations…"
        />
        <button type="button" onclick={() => void submitSearch()} disabled={!query.trim() || searching}
          aria-label={searching ? "Searching saved conversations" : "Search saved conversations"}
          title="Search session titles and indexed first/final messages (Enter)"
          class="absolute top-0.5 right-6 flex h-6 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60">
          {#if searching}<LoaderCircle class="h-3 w-3 animate-spin" aria-hidden="true" />{:else}Search{/if}
        </button>
      </div>
      {#if searching}<p role="status" class="mt-1 text-xs text-muted-foreground">Searching…</p>{:else if searchNotice}<p role="status" class="mt-1 text-xs text-muted-foreground">{searchNotice}</p>{/if}
    </header>

    <div bind:this={scrollContainer} class="min-h-0 overflow-y-auto border-t border-border/70" aria-label="Saved conversations">
      {#each visibleSessions as row (row.session.sessionId)}
        <SavedSessionRow {row} collapsed={collapsed.has(row.session.sessionId)}
          related={sessionRowsRelated(row, activeRow)}
          date={displayDate(row.session.updatedAt) || row.session.sessionId.slice(0, 8)}
          onSelect={() => onSelect(row.session.sessionId)}
          onToggle={() => toggleBranch(row.session.sessionId)}
          onActivate={(active, source) => activateRow(row, active, source)} />
      {:else}
        {#if displayedSessions.length === 0}
          <p class="px-3 py-6 text-center text-xs text-muted-foreground">
            {query ? "No matching saved conversations" : "No saved conversations outside the open tabs"}
          </p>
        {/if}
      {/each}
      {#if hasMore}
        <div class="flex flex-col items-center gap-1 px-3 py-2 text-xs text-muted-foreground">
          <span aria-live="polite">Showing {visibleSessions.length} of {displayedSessions.length} conversations</span>
          <button bind:this={loadMoreTrigger} type="button" onclick={loadNextPage}
            class="rounded-sm px-2 py-1 text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring">
            Show {Math.min(SAVED_SESSION_NEXT_ROWS, displayedSessions.length - visibleCount)} more
          </button>
        </div>
      {/if}
    </div>
  </div>
</section>
