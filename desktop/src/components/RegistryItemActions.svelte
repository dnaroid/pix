<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import FileDiff from "@lucide/svelte/icons/file-diff";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import PackagePlus from "@lucide/svelte/icons/package-plus";
  import Download from "@lucide/svelte/icons/download";
  import Upload from "@lucide/svelte/icons/upload";
  import { registryDiffAvailable, registryFriendlyActionLabel, registryScopeToggleDestination,
    type RegistryItem, type RegistryItemAction } from "../lib/registry";
  import { registryCardActions, registryMenuPosition } from "../lib/registry-card-actions";
  import { isTypeaheadKey, menuFocusIndex, menuTypeaheadFocusIndex } from "../lib/keyboard-navigation";

  let { item, remoteDisabled, actionId, projectKey, diffBusy, onAction, onDiff }: {
    item: RegistryItem;
    remoteDisabled: boolean;
    actionId: string | null;
    projectKey: string | undefined;
    diffBusy: boolean;
    onAction: (action: RegistryItemAction) => void;
    onDiff: () => void;
  } = $props();
  const actions = $derived(registryCardActions(item));
  const busy = $derived(remoteDisabled || actionId !== null);
  const setupHint = 'Project visibility needs a project key first — set one with "Set project key" in the Project sync section.';
  let open = $state(false);
  let trigger = $state<HTMLButtonElement | null>(null);
  let menu = $state<HTMLDivElement | null>(null);
  let position = $state<{ left: number; top: number } | null>(null);
  let query = "";
  let queryAt = 0;
  let generation = 0;
  onDestroy(() => { generation += 1; });

  function blocked(action: RegistryItemAction): boolean {
    return action === "toggle-scope" && registryScopeToggleDestination(item) === "project" && !projectKey;
  }
  function tone(action: RegistryItemAction): string {
    if (action === "remove" || action === "make-local") return "text-tool-error hover:bg-tool-error/10";
    if (action === "uninstall" || (item.status === "untracked-local" && (action === "push" || action === "pull")))
      return "text-tool-warning hover:bg-tool-warning/10";
    return "text-muted-foreground hover:bg-accent hover:text-foreground";
  }
  function close(restoreFocus = false): void {
    generation += 1;
    open = false;
    position = null;
    query = "";
    if (restoreFocus) trigger?.focus();
  }
  function buttons(): HTMLButtonElement[] {
    return [...(menu?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [])];
  }
  function navigationItems() {
    return actions.secondary.map((action) => ({ label: registryFriendlyActionLabel(item, action), disabled: busy || blocked(action) }));
  }
  async function show(last = false): Promise<void> {
    const request = ++generation;
    open = true;
    await tick();
    if (request !== generation || !open || !menu || !trigger) return;
    const rect = menu.getBoundingClientRect();
    position = registryMenuPosition(trigger.getBoundingClientRect(), rect.width, rect.height, window.innerWidth, window.innerHeight);
    await tick();
    if (request !== generation || !open || !menu) return;
    const index = menuFocusIndex(navigationItems(), -1, last ? "ArrowUp" : "ArrowDown");
    if (index === null) menu.focus();
    else buttons()[index]?.focus();
  }
  function keydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") { close(true); return; }
    const current = buttons().indexOf(document.activeElement as HTMLButtonElement);
    let next = menuFocusIndex(navigationItems(), current, event.key);
    if (next === null && isTypeaheadKey(event)) {
      const now = Date.now();
      const key = event.key.toLocaleLowerCase();
      query = now - queryAt > 700 || query === key ? key : query + key;
      queryAt = now;
      next = menuTypeaheadFocusIndex(navigationItems(), current, query);
      if (next === null) {
        query = key;
        next = menuTypeaheadFocusIndex(navigationItems(), current, query);
      }
    } else if (next === null) return;
    event.preventDefault();
    if (next !== null) buttons()[next]?.focus();
  }
  // Escape the Registry's scrolling/overflow container; remove the portal on teardown.
  function portal(node: HTMLDivElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }
  $effect(() => {
    // A refreshed snapshot/changed availability must not leave stale commands open.
    item; busy; projectKey;
    close();
  });
  $effect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node | null;
      if (target && !menu?.contains(target) && !trigger?.contains(target)) close();
    };
    const scroll = (event: Event) => { if (!menu?.contains(event.target as Node)) close(); };
    const resize = () => close(true);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
    };
  });
</script>

<div class="flex shrink-0 items-center gap-0.5">
  {#if registryDiffAvailable(item)}
    <button class="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
      type="button" disabled={remoteDisabled || diffBusy} title={`Compare registry and local copies: ${item.name}`}
      aria-label={`Compare registry and local copies: ${item.name}`} data-registry-diff-trigger={item.id} onclick={onDiff}>
      {#if diffBusy}<RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      {:else}<FileDiff class="h-3.5 w-3.5" aria-hidden="true" />{/if}
    </button>
  {/if}
  {#if actions.primary}
    {@const action = actions.primary}
    <button class={["grid h-6 w-6 place-items-center rounded-md focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40", tone(action)]}
      type="button" disabled={busy} title={registryFriendlyActionLabel(item, action)}
      aria-label={`${registryFriendlyActionLabel(item, action)}: ${item.name}`} onclick={() => onAction(action)}>
      {#if actionId === `${item.id}:${action}`}<RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      {:else if action === "install"}<PackagePlus class="h-3.5 w-3.5" aria-hidden="true" />
      {:else if action === "update" || action === "pull"}<Download class="h-3.5 w-3.5" aria-hidden="true" />
      {:else}<Upload class="h-3.5 w-3.5" aria-hidden="true" />{/if}
    </button>
  {/if}
  {#if actions.secondary.length}
    <button bind:this={trigger} class="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`More actions: ${item.name}`} title={`More actions: ${item.name}`}
      onclick={() => open ? close(true) : void show()}
      onkeydown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); void show(event.key === "ArrowUp"); } }}>
      {#if actions.secondary.some((action) => actionId === `${item.id}:${action}`)}
        <RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      {:else}<Ellipsis class="h-3.5 w-3.5" aria-hidden="true" />{/if}
    </button>
  {/if}
</div>
{#if open}
  <div use:portal bind:this={menu} role="menu" tabindex="-1" aria-label={`Actions for ${item.name}`} onkeydown={keydown}
    class="fixed z-50 w-60 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
    style:max-width="calc(100vw - 1rem)" style:max-height="calc(100vh - 1rem)" style:left={`${position?.left ?? 0}px`} style:top={`${position?.top ?? 0}px`}
    style:visibility={position ? "visible" : "hidden"}>
    {#each actions.secondary as action}
      <button role="menuitem" tabindex="-1" type="button" disabled={busy || blocked(action)}
        class={["flex min-h-7 w-full items-center rounded-sm px-2 py-1 text-left text-xs focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40", tone(action)]}
        title={blocked(action) ? setupHint : registryFriendlyActionLabel(item, action)}
        onclick={() => { close(true); onAction(action); }}>
        {registryFriendlyActionLabel(item, action)}
        {#if blocked(action)}<span class="sr-only"> — {setupHint}</span>{/if}
      </button>
    {/each}
  </div>
{/if}
