<script lang="ts">
  import Play from "@lucide/svelte/icons/play";
  import Square from "@lucide/svelte/icons/square";
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
    style:max-height={controller.state.maxHeight === null ? undefined : `${controller.state.maxHeight}px`}
    role="menu"
    tabindex="-1"
    aria-label="Indicator actions"
    onkeydown={controller.keydown}
  >
    {#if controller.state.tab === "scripts"}
      <input
        bind:this={controller.state.filterInput}
        bind:value={controller.state.filter}
        class="sticky top-0 z-10 mb-1 w-full border-b border-border bg-popover px-2 py-1.5 text-xs outline-none"
        aria-label="Filter launch commands"
        placeholder="Filter commands…"
        autocomplete="off"
        spellcheck="false"
      />
      {#if !groups.some((group) => group.id === "scripts.commands" && group.actions.length)}
        <div class="px-2 py-1.5 text-xs text-muted-foreground" role="status">No matching commands</div>
      {/if}
    {/if}
    {#each groups as group (group.id)}
      {#if group.id !== "scripts.commands"}
        <div class="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">{group.reason}</div>
      {/if}
      {#each group.actions as action (action.id)}
        <button
          class="flex min-h-7 w-full items-center rounded-sm px-2 py-1 text-left text-xs hover:bg-panel-hover focus-visible:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
          type="button"
          role="menuitem"
          aria-label={action.label}
          title={action.icon ? action.label : undefined}
          tabindex="-1"
          disabled={action.disabled}
          onclick={() => onAction(action.id)}
        >
          {#if action.icon === "play"}
            <Play class="mr-2 h-3 w-3 shrink-0 fill-current" aria-hidden="true" />
          {:else if action.icon === "stop"}
            <Square class="mr-2 h-3 w-3 shrink-0 fill-current text-tool-error" aria-hidden="true" />
          {/if}
          {action.commandName ?? action.label}
        </button>
      {/each}
    {/each}
  </div>
{/if}
