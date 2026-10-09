<script lang="ts">
  import Search from "@lucide/svelte/icons/search";
  import { onMount } from "svelte";
  import type { SessionInfo } from "@agentclientprotocol/sdk";
  import { fuzzySearch } from "../lib/fuzzy";
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
    onSelect,
  }: {
    sessions: readonly SessionInfo[];
    workspace: string;
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
  const displayedSessions = $derived(query.trim()
    ? fuzzySearch(
      sessions.map((session) => ({
        value: session,
        label: session.title ?? "Untitled conversation",
        aliases: [session.sessionId],
        keywords: [displayDate(session.updatedAt)],
      })),
      query,
    ).map((match) => flatSessionRow(match.value))
    : expandedSessionRows(buildSessionTree(sessions), collapsed));
  const visibleSessions = $derived(visibleSavedSessionRows(displayedSessions, visibleCount));
  const hasMore = $derived(visibleCount < displayedSessions.length);
  const activeRow = $derived(displayedSessions.find((row) => row.session.sessionId === (hoveredId ?? focusedId)) ?? null);

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
      <label class="relative mt-2 block">
        <span class="sr-only">Search saved conversations</span>
        <Search class="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          class="h-7 w-full rounded-md border border-input bg-panel-strong pr-2 pl-7 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/25"
          bind:this={searchInput}
          bind:value={query}
          oninput={resetPages}
          type="search"
          placeholder="Search saved conversations…"
        />
      </label>
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
