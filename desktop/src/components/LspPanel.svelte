<script lang="ts">
  import { onMount, untrack } from "svelte";
  import CodeXml from "@lucide/svelte/icons/code-xml";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import type { AcpClient, LspSnapshot } from "../lib/acp-client";

  let { client, sessionId }: { client: AcpClient | null; sessionId: string | null } = $props();
  let snapshot = $state<LspSnapshot | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let generation = 0;

  async function refresh(targetClient: AcpClient | null, targetSession: string | null, targetGeneration: number): Promise<void> {
    if (!targetClient || !targetSession || busy) return;
    busy = true;
    try {
      const result = await targetClient.lspControl(targetSession, "status");
      if (generation === targetGeneration && client === targetClient && sessionId === targetSession) {
        snapshot = result;
        error = null;
      }
    } catch (cause) {
      if (generation === targetGeneration && client === targetClient && sessionId === targetSession) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    const targetClient = client;
    const targetSession = sessionId;
    const targetGeneration = ++generation;
    snapshot = null;
    error = null;
    untrack(() => void refresh(targetClient, targetSession, targetGeneration));
  });

  onMount(() => {
    const timer = window.setInterval(() => void refresh(client, sessionId, generation), 4000);
    return () => {
      generation += 1;
      window.clearInterval(timer);
    };
  });
</script>

<section class="flex min-h-0 min-w-0 flex-col overflow-hidden bg-panel" aria-label="Language servers">
  <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
    {#if !sessionId}
      <p class="text-xs text-muted-foreground">Open a conversation session to monitor project language servers.</p>
    {:else if !client}
      <p class="text-xs text-muted-foreground">Connect to Pix to inspect language servers.</p>
    {/if}
    {#if error}
      <div class="flex items-start gap-2 border-l-2 border-tool-error px-2 py-1.5 text-xs text-tool-error" role="alert">
        <TriangleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span class="min-w-0 break-words">{error}</span>
      </div>
    {/if}
    {#if snapshot?.warnings.length}
      <div class="border-l-2 border-tool-warning px-2 py-1.5 text-xs leading-5 text-tool-warning" role="status">
        {#each snapshot.warnings as warning}<p>{warning}</p>{/each}
        {#if snapshot.trustRequired}<p class="mt-1 text-muted-foreground">Project configuration trust will be requested when a matching file is edited.</p>{/if}
      </div>
    {/if}
    {#if snapshot && snapshot.servers.length === 0}
      <p class="text-xs text-muted-foreground">No running language servers for this project.</p>
    {/if}
    {#each snapshot?.servers ?? [] as server (server.id + server.root)}
      <article class="border-b border-border pb-3 last:border-b-0" aria-label={`${server.id} at ${server.root}`}>
        <div class="flex min-w-0 items-center gap-2">
          <CodeXml class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <strong class="min-w-0 flex-1 truncate text-xs font-medium">{server.id}</strong>
          <span class="shrink-0 text-xs text-muted-foreground">{server.state}</span>
        </div>
        <p class="mt-1 break-all font-mono text-xs text-muted-foreground">{server.root}</p>
        {#if server.pid !== undefined}<p class="mt-1 font-mono text-xs text-muted-foreground">PID {server.pid}</p>{/if}
        {#if server.error}<p class="mt-1 break-words text-xs text-tool-error">{server.error}</p>{/if}
      </article>
    {/each}
  </div>
  <footer class="flex h-9 shrink-0 items-center gap-2 border-t border-border px-3">
    <button class="ml-auto grid h-7 w-7 place-items-center rounded-sm text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" aria-label="Refresh language server status" title="Refresh status" disabled={!client || !sessionId || busy} onclick={() => void refresh(client, sessionId, generation)}><RotateCw class="h-3.5 w-3.5" aria-hidden="true" /></button>
  </footer>
</section>
