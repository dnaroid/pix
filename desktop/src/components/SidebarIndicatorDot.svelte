<script lang="ts">
  import type { SidebarIndicator } from "../lib/sidebar-indicators";

  let { indicator }: { indicator?: SidebarIndicator } = $props();

  const toneClass = $derived(
    indicator?.tone === "error"
      ? "bg-tool-error"
      : indicator?.tone === "warning"
        ? "bg-tool-warning"
        : "bg-tool-info",
  );
</script>

{#if indicator}
  <span
    class={["absolute top-2 right-2 h-1.5 w-1.5 rounded-full", toneClass]}
    title={indicator.reason}
    aria-hidden="true"
  ></span>
{/if}
