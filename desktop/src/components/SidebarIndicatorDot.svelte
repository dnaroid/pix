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
    class="absolute top-1 right-1 h-[5px] w-[5px]"
    title={indicator.reason}
    aria-hidden="true"
  >
    {#if indicator.animated}
      <span class={["absolute inset-0 rounded-full opacity-70 motion-safe:animate-ping", toneClass]}></span>
    {/if}
    <span class={["absolute inset-0 rounded-full ring-1 ring-chrome", toneClass]}></span>
  </span>
{/if}
