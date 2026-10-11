<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { onMount } from "svelte";
  type Status = { configured: boolean; provider: string | null; model: string | null; vectorSize: number | null; keyAvailable: boolean };
  let { workspace, onSettings, onChanged = () => {} }: { workspace: string; onSettings?: () => void; onChanged?: () => void } = $props();
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
  <div class="flex items-center justify-between gap-2 text-xs">
    <span class="font-medium text-foreground">Semantic search</span>
    <button type="button" onclick={onSettings} class="rounded px-1 py-0.5 text-tool-search hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Configure in Settings</button>
  </div>
  {#if status?.configured}<p class="text-xs text-muted-foreground" role="status">Configured: {status.provider} · {status.model} · {status.vectorSize} dimensions{status.provider === "openrouter" && !status.keyAvailable ? " · API key missing" : ""}. Vectors are created on demand.</p>
  {:else if status}<p class="text-xs text-muted-foreground" role="status">Not configured; semantic search is off. Local results remain available.</p>
  {:else}<p class="text-xs text-muted-foreground" role="status">Semantic configuration status unavailable.</p>{/if}
</section>
