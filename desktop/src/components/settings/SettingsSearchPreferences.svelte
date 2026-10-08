<script lang="ts">
  import { untrack } from "svelte";
  import { SEARCH_EMBEDDING_MODEL, type SearchConfigRequest, type SearchStatus } from "../../../../acp/src/search/contract";

  let { cwd, client }: {
    cwd: string;
    client?: { searchConfig: (cwd: string, changes?: Omit<SearchConfigRequest, "cwd">, signal?: AbortSignal) => Promise<SearchStatus> };
  } = $props();
  let status = $state<SearchStatus | null>(null);
  let apiKey = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  let context: { client: NonNullable<typeof client>; cwd: string; controller: AbortController } | null = null;
  $effect(() => {
    const next = client ? { client, cwd, controller: new AbortController() } : null;
    context = next;
    status = null;
    busy = false;
    error = null;
    apiKey = "";
    if (next) untrack(() => { void update(); });
    return () => { next?.controller.abort(); if (context === next) context = null; };
  });

  async function update(changes?: Omit<SearchConfigRequest, "cwd">): Promise<void> {
    const target = context;
    if (!target || busy) return;
    busy = true;
    error = null;
    try {
      const next = await target.client.searchConfig(target.cwd, changes, target.controller.signal);
      if (context !== target || target.controller.signal.aborted) return;
      status = next;
      if (changes?.apiKey !== undefined) apiKey = "";
    } catch (caught) {
      if (context === target && !target.controller.signal.aborted) error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (context === target) busy = false;
    }
  }
</script>

<div class="border-y border-sidebar-border/70 bg-panel" data-settings-field-id="semantic-search" data-settings-field="Semantic settings search OpenRouter Perplexity privacy">
  <div class="px-2.5 py-2.5">
    <div class="text-xs font-medium text-foreground">Semantic search</div>
    <dl class="mt-2 space-y-1 text-xs">
      <div><dt class="inline text-muted-foreground">Embedding model: </dt><dd class="inline break-all font-mono text-foreground">{SEARCH_EMBEDDING_MODEL}</dd></div>
      <div><dt class="inline text-muted-foreground">Provider: </dt><dd class="inline text-foreground">OpenRouter</dd></div>
    </dl>
    <p class="mt-2 text-xs leading-4 text-muted-foreground">Settings semantic search sends only authored settings labels/descriptions and settings queries to OpenRouter. Session titles require their own separate opt-in. Conversation history and attachments are never sent by this search.</p>
    <p class="mt-1 text-xs leading-4 text-muted-foreground">Both semantic options are off by default. Local session-title and settings search remains available without provider calls.</p>
    {#if client}
      <label class="mt-2 flex items-center gap-2 text-xs text-foreground">
        <input type="checkbox" checked={status?.enabled ?? false} disabled={!status || busy} onchange={(event) => void update({ enabled: event.currentTarget.checked })} />
        Enable semantic settings search
      </label>
      <label class="mt-2 flex items-start gap-2 text-xs text-foreground">
        <input type="checkbox" class="mt-0.5" checked={status?.sessionTitlesEnabled ?? false} disabled={!status || busy}
          onchange={(event) => void update({ sessionTitlesEnabled: event.currentTarget.checked })} />
        <span>Enable semantic session-title search
          <span class="mt-1 block leading-4 text-muted-foreground">Sends explicitly saved session names and session-search queries to OpenRouter for embeddings; may incur charges. Never sends first-message fallback titles or conversation contents.</span>
        </span>
      </label>
      {#if status}
        {#if status.keyAvailable}
          <p class="mt-2 text-xs text-tool-success" role="status">OpenRouter key configured.</p>
        {:else}
          <label class="mt-2 block text-xs text-muted-foreground" for="settings-search-api-key">OpenRouter API key</label>
          <div class="mt-1 flex gap-1.5">
            <input id="settings-search-api-key" bind:value={apiKey} type="password" autocomplete="new-password" aria-label="OpenRouter API key" placeholder="Enter key" class="h-7 min-w-0 flex-1 rounded-md border border-input bg-panel-strong px-2 text-xs text-foreground" />
            <button type="button" class="h-7 rounded-md border border-border px-2 text-xs text-foreground hover:bg-panel-hover disabled:opacity-40" disabled={!apiKey.trim() || busy} onclick={() => void update({ apiKey: apiKey.trim() })}>{busy ? "Saving…" : "Save key"}</button>
          </div>
          <p class="mt-1 text-xs text-muted-foreground">The key is write-only and stored in the shared OpenRouter credential store; it is never shown or saved in Desktop settings.</p>
        {/if}
      {/if}
    {:else}
      <p class="mt-2 text-xs text-muted-foreground">Search service is unavailable in this workspace.</p>
    {/if}
    {#if busy && !status}<p class="mt-2 text-xs text-muted-foreground" role="status">Loading search preferences…</p>{/if}
    {#if error || status?.error}<p class="mt-2 text-xs text-tool-error" role="alert">{error ?? status?.error}</p>{/if}
  </div>
</div>
