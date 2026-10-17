<script lang="ts">
  let { label = "Loading usage…", tall = false }: { label?: string; tall?: boolean } = $props();
</script>

<div class={["flex flex-col justify-center gap-2", tall ? "min-h-28" : "min-h-16"]} role="status" aria-label={label}>
  <span class="sr-only">{label}</span>
  <div class="h-3 w-2/3 animate-pulse rounded-sm bg-border motion-reduce:animate-none"></div>
  <div class="h-3 w-full animate-pulse rounded-sm bg-border motion-reduce:animate-none"></div>
  <div class="h-3 w-1/2 animate-pulse rounded-sm bg-border motion-reduce:animate-none"></div>
</div>
