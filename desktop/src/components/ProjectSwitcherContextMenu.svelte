<script lang="ts">
  import { onDestroy, tick, type Snippet } from "svelte";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import X from "@lucide/svelte/icons/x";
  import { isTypeaheadKey, menuFocusIndex, menuTypeaheadFocusIndex } from "../lib/keyboard-navigation";

  let { children, onRemove, onOpenInFinder }: {
    children: Snippet;
    onRemove?: (path: string) => void;
    onOpenInFinder?: (path: string) => void;
  } = $props();
  let target = $state.raw<{ path: string; invoker: HTMLElement; x: number; y: number } | null>(null);
  let menu = $state<HTMLDivElement | null>(null);
  let query = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const actions = $derived([
    { label: "Open in Finder", run: onOpenInFinder },
    { label: "Remove from recent projects", run: onRemove },
  ].filter((action) => action.run));

  function close(restore = false): void {
    const invoker = target?.invoker;
    target = null;
    query = "";
    clearTimeout(timer);
    if (restore && invoker?.isConnected) invoker.focus({ preventScroll: true });
  }
  onDestroy(() => close());

  function buttons(): HTMLButtonElement[] {
    return [...(menu?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
  }

  function open(event: MouseEvent | KeyboardEvent): void {
    if (!actions.length || !(event.target instanceof Element)) return;
    const row = event.target.closest<HTMLElement>("[data-project-path]");
    if (!row?.dataset.projectPath) return;
    event.preventDefault();
    event.stopPropagation();
    close();
    const invoker = event.target.closest<HTMLElement>("button") ?? row;
    const rect = invoker.getBoundingClientRect();
    const pointer = event instanceof MouseEvent && (event.clientX !== 0 || event.clientY !== 0);
    const request = { path: row.dataset.projectPath, invoker,
      x: pointer ? event.clientX : rect.left, y: pointer ? event.clientY : rect.bottom };
    target = request;
    void tick().then(() => {
      if (target !== request || !menu) return;
      const bounds = menu.getBoundingClientRect();
      target = { ...request,
        x: Math.max(8, Math.min(request.x, window.innerWidth - bounds.width - 8)),
        y: Math.max(8, Math.min(request.y, window.innerHeight - bounds.height - 8)) };
      buttons()[0]?.focus();
    });
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      open(event);
      return;
    }
    if (!target || !menu?.contains(event.target as Node)) return;
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); close(true); return; }
    if (event.key === "Tab") { close(true); return; }
    const elements = buttons();
    const index = elements.indexOf(event.target as HTMLButtonElement);
    let next = menuFocusIndex(actions, index, event.key);
    if (next === null && isTypeaheadKey(event)) {
      const key = event.key.toLocaleLowerCase();
      query = query === key ? key : query + key;
      next = menuTypeaheadFocusIndex(actions, index, query);
      if (next === null) { query = key; next = menuTypeaheadFocusIndex(actions, index, query); }
      clearTimeout(timer);
      timer = setTimeout(() => query = "", 700);
      event.preventDefault();
    }
    if (next !== null) { event.preventDefault(); elements[next]?.focus(); }
  }

  function outside(event: Event): void {
    if (target && event.target instanceof Node && !menu?.contains(event.target)) close();
  }

  function run(action: (path: string) => void): void {
    if (!target) return;
    const path = target.path;
    const search = target.invoker.closest('[aria-label="Select project"]')?.querySelector<HTMLInputElement>('input[aria-label="Search projects"]');
    close(true);
    action(path);
    // Removal unmounts the invoker; keep keyboard navigation in the switcher.
    void tick().then(() => {
      if (search?.isConnected && document.activeElement === document.body) {
        search.focus();
      }
    });
  }
</script>

<svelte:window onpointerdown={outside} onfocusin={outside} onresize={() => close()} onblur={() => close()} />

<!-- Delegated events serve the native buttons in the project list. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="contents" role="group" oncontextmenu={open} onkeydown={keydown} onscrollcapture={() => close()}>
  {@render children()}
  {#if target}
    <div bind:this={menu} role="menu" tabindex="-1" aria-label="Project actions"
      class="fixed z-[100] max-w-[calc(100vw-16px)] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
      style:left={`${target.x}px`} style:top={`${target.y}px`}>
      {#each actions as action}
        <button type="button" role="menuitem" tabindex="-1"
          class="flex min-h-7 w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-panel-hover focus-visible:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring"
          onclick={() => action.run && run(action.run)}>
          {#if action.run === onOpenInFinder}<FolderOpen class="h-3.5 w-3.5" aria-hidden="true" />
          {:else}<X class="h-3.5 w-3.5" aria-hidden="true" />{/if}
          {action.label}
        </button>
      {/each}
    </div>
  {/if}
</div>
