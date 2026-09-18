<script lang="ts">
  import GitFork from "@lucide/svelte/icons/git-fork";
  import Search from "@lucide/svelte/icons/search";
  import { onMount } from "svelte";
  import type { SessionInfo } from "@agentclientprotocol/sdk";
  import { fuzzySearch } from "../lib/fuzzy";
  import { buildSessionTree, sessionIsFork } from "../lib/session-tabs";

  let {
    sessions,
    onSelect,
  }: {
    sessions: readonly SessionInfo[];
    onSelect: (sessionId: string) => void;
  } = $props();

  let query = $state("");
  let searchInput = $state<HTMLInputElement | null>(null);
  const displayedSessions = $derived(query.trim()
    ? fuzzySearch(
      sessions.map((session) => ({
        value: session,
        label: session.title ?? "Untitled conversation",
        aliases: [session.sessionId],
        keywords: [displayDate(session.updatedAt)],
      })),
      query,
    ).map((match) => ({ session: match.value, treePrefix: "" }))
    : buildSessionTree(sessions));

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
          type="search"
          placeholder="Search saved conversations…"
        />
      </label>
    </header>

    <div class="min-h-0 overflow-y-auto border-t border-border/70" aria-label="Saved conversations">
      {#each displayedSessions as row (row.session.sessionId)}
        <button
          class="grid h-7 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/50 px-2.5 text-left transition-colors last:border-b-0 hover:bg-panel-hover focus-visible:bg-panel-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          type="button"
          onclick={() => onSelect(row.session.sessionId)}
        >
          <strong class="flex min-w-0 items-center gap-1 text-xs font-medium text-foreground">
            {#if row.treePrefix}
              <span class="shrink-0 whitespace-pre font-mono text-muted-foreground" aria-hidden="true">{row.treePrefix}</span>
            {/if}
            {#if !row.treePrefix && sessionIsFork(row.session)}
              <GitFork class="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            {/if}
            <span class="min-w-0 truncate">{row.session.title || "Untitled conversation"}</span>
          </strong>
          <small class="shrink-0 font-mono text-xs text-muted-foreground">{displayDate(row.session.updatedAt) || row.session.sessionId.slice(0, 8)}</small>
        </button>
      {:else}
        <p class="px-3 py-6 text-center text-xs text-muted-foreground">
          {query ? "No matching saved conversations" : "No saved conversations outside the open tabs"}
        </p>
      {/each}
    </div>
  </div>
</section>
