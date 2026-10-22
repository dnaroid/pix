<script lang="ts">
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import Info from "@lucide/svelte/icons/info";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import type { ToastLevel } from "../app/toasts.svelte";

  let { level, class: className = "h-4 w-4 shrink-0" }: { level: ToastLevel; class?: string } = $props();
</script>

{#if level === "success"}
  <CircleCheck class={[className, "text-tool-success"]} aria-hidden="true" />
{:else if level === "warning"}
  <TriangleAlert class={[className, "text-tool-warning"]} aria-hidden="true" />
{:else if level === "error"}
  <CircleAlert class={[className, "text-tool-error"]} aria-hidden="true" />
{:else}
  <Info class={[className, "text-muted-foreground"]} aria-hidden="true" />
{/if}
