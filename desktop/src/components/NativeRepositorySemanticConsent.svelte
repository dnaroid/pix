<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { onMount } from "svelte";
  type Status = { configured: boolean; provider: string | null; model: string | null; vectorSize: number | null; keyAvailable: boolean };
  let { workspace, onChanged = () => {} }: { workspace: string; onChanged?: () => void } = $props();
  let status = $state<Status | null>(null);
  let generation = 0;
  async function refresh() {
    const request = ++generation;
    try { const value = await invoke<Status>("native_repository_semantic_config"); if (request === generation) status = value; }
    catch { if (request === generation) status = null; }
  }
  $effect(() => { void workspace; void refresh(); return () => { generation++; }; });
  onMount(() => {
    const changed = () => { void refresh(); onChanged(); };
    window.addEventListener("pix-semantic-config-changed", changed);
    return () => { window.removeEventListener("pix-semantic-config-changed", changed); generation++; };
  });
</script>

<section class="space-y-1.5 border-t border-border pt-2" aria-label="Semantic search configuration status">
  {#if status?.configured}<p class="text-xs text-muted-foreground" role="status">Semantic search · {status.model}{status.provider === "openrouter" && !status.keyAvailable ? " · API key missing" : ""}</p>
    <p class="text-xs text-muted-foreground">Queries and indexed source text may be sent to {status.provider} for embeddings; provider charges may apply.</p>
  {:else if status}<p class="text-xs text-muted-foreground" role="status">Semantic search off · local search available</p>
  {:else}<p class="text-xs text-muted-foreground" role="status">Semantic configuration status unavailable.</p>{/if}
</section>
