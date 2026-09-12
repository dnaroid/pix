<script lang="ts">
  import type { ComponentProps } from "svelte";
  import SessionSelector from "./SessionSelector.svelte";
  import WorkbenchTabs from "./WorkbenchTabs.svelte";

  let {
    isMacOS,
    workbench,
    selector,
  }: {
    isMacOS: boolean;
    workbench: ComponentProps<typeof WorkbenchTabs>;
    selector: ComponentProps<typeof SessionSelector> | null;
  } = $props();
</script>

<header
  class="flex min-w-0 select-none items-stretch border-b border-border bg-window-titlebar text-chrome-foreground"
  data-tauri-drag-region
>
  <div class={["shrink-0", isMacOS ? "w-[76px]" : "w-3"]} data-tauri-drag-region></div>

  <div class="relative flex min-w-0 flex-1" data-tauri-drag-region>
    <WorkbenchTabs {...workbench} />

    {#if selector}
      <SessionSelector {...selector} />
    {/if}
  </div>
</header>
