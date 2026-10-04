<script lang="ts">
  import type { SidebarIndicatorActionGroup, SidebarIndicatorActionId } from "../lib/sidebar-indicator-actions";
  import type { createSidebarIndicatorMenuController } from "./sidebar-indicator-menu-controller.svelte";
  let { controller, groups, onAction }: {
    controller: ReturnType<typeof createSidebarIndicatorMenuController>;
    groups: readonly SidebarIndicatorActionGroup[];
    onAction: (id: SidebarIndicatorActionId) => void;
  } = $props();
</script>

{#if controller.state.position && groups.length}
  <div
    bind:this={controller.state.element}
    class="fixed z-[100] max-h-[calc(100vh-1rem)] w-64 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
    style:left={`${controller.state.position.left}px`}
    style:top={`${controller.state.position.top}px`}
    role="menu"
    tabindex="-1"
    aria-label="Indicator actions"
    onkeydown={controller.keydown}
  >
    {#each groups as group (group.id)}
      <div class="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">{group.reason}</div>
      {#each group.actions as action (action.id)}
        <button
          class="flex min-h-7 w-full items-center rounded-sm px-2 py-1 text-left text-xs hover:bg-panel-hover focus-visible:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
          type="button"
          role="menuitem"
          tabindex="-1"
          disabled={action.disabled}
          onclick={() => onAction(action.id)}
        >{action.label}</button>
      {/each}
    {/each}
  </div>
{/if}
