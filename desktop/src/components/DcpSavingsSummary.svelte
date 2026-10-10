<script lang="ts">
  let { tokensSaved }: { tokensSaved: number } = $props();
  const formatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 0 });
  const hasSavings = $derived(tokensSaved > 0);
</script>

<div class={[
  "mt-2 flex items-center justify-between gap-3 rounded-md border px-2.5 py-1.5",
  hasSavings
    ? "border-tool-success/30 bg-tool-success/10 text-tool-success"
    : "border-border text-muted-foreground",
]}>
  <span class="text-xs">{hasSavings ? "DCP saved you" : "DCP savings"}</span>
  <span class="font-mono text-xs font-semibold">~{formatter.format(tokensSaved)} tokens</span>
</div>
