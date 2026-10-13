<script lang="ts">
  import SettingsSearchToggle from "./SettingsSearchToggle.svelte";
  let { cwd }: { cwd: string } = $props();
</script>

<SettingsSearchToggle {cwd} />

<div class="border-y border-sidebar-border/70 bg-panel px-2.5 py-2.5" data-settings-field="Semantic search provider model dimensions upload cost" data-workspace={cwd}>
  <div class="text-xs font-medium text-foreground">Semantic search</div>
  <p class="mt-1 text-xs leading-4 text-muted-foreground">Provider and embedding settings are managed under Tools Suite → Search, independently of ACP sessions. One valid saved configuration controls every source and project; there are no per-source consent toggles. Local search remains available without provider configuration.</p>
  <p class="mt-1 text-xs leading-4 text-muted-foreground">RAG is separate: when you explicitly request an answer, bounded retrieved source excerpts and the question are sent to the selected RAG model provider. Configure its model and thinking effort above.</p>
</div>
