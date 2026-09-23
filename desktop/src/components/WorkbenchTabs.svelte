<script lang="ts">
  import FileCode from "@lucide/svelte/icons/file-code";
  import GitCompareArrows from "@lucide/svelte/icons/git-compare-arrows";
  import GitFork from "@lucide/svelte/icons/git-fork";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";
  import { tick } from "svelte";
  import { linearFocusIndex } from "../lib/keyboard-navigation";
  import {
    workbenchTabCloseFallback,
    type WorkbenchTab,
    type WorkbenchTabId,
  } from "../lib/workbench-tabs";
  import { titlebarDrag } from "../lib/titlebar-drag";
  import SessionTabStatusIcon from "./SessionTabStatusIcon.svelte";

  let {
    tabs,
    activeId,
    canCreateSession,
    newSessionShortcut,
    onSelect,
    onClose,
    onCreateSession,
  }: {
    tabs: readonly WorkbenchTab[];
    activeId: WorkbenchTabId | null;
    canCreateSession: boolean;
    newSessionShortcut?: string;
    onSelect: (id: WorkbenchTabId) => void;
    onClose: (id: WorkbenchTabId, fallbackId: WorkbenchTabId | null) => boolean | Promise<boolean>;
    onCreateSession: () => void;
  } = $props();

  let tablist = $state<HTMLElement | null>(null);

  function focusTab(id: WorkbenchTabId): void {
    const tab = tablist?.querySelector<HTMLButtonElement>(`[data-workbench-tab-id="${CSS.escape(id)}"]`);
    tab?.focus();
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function handleTabKeydown(event: KeyboardEvent, index: number, tab: WorkbenchTab): void {
    const nextIndex = linearFocusIndex(index, event.key, tabs.length, "horizontal", true);
    if (nextIndex !== null) {
      event.preventDefault();
      const next = tabs[nextIndex];
      if (next) focusTab(next.id);
      return;
    }
    if (event.key !== "Delete" || tab.disabled || !tab.closable) return;
    event.preventDefault();
    void closeAndRestoreFocus(tab.id);
  }

  async function closeAndRestoreFocus(id: WorkbenchTabId): Promise<void> {
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab || tab.disabled || !tab.closable) return;
    const fallbackId = workbenchTabCloseFallback(tabs, id);
    const closed = await onClose(id, fallbackId);
    if (!closed) return;
    await tick();
    const existing = tablist?.querySelector<HTMLButtonElement>(`[data-workbench-tab-id="${CSS.escape(id)}"]`);
    if (existing?.isConnected) {
      existing.focus();
      return;
    }
    if (fallbackId) {
      const fallback = tablist?.querySelector<HTMLButtonElement>(`[data-workbench-tab-id="${CSS.escape(fallbackId)}"]`);
      if (fallback?.isConnected) {
        focusTab(fallbackId);
        return;
      }
    }
    tablist?.parentElement?.querySelector<HTMLButtonElement>("[data-session-new]")?.focus();
  }

  function handleTabMouseDown(event: MouseEvent, tab: WorkbenchTab): void {
    if (event.button !== 1 || tab.disabled || !tab.closable) return;
    event.preventDefault();
    event.stopPropagation();
    void closeAndRestoreFocus(tab.id);
  }
</script>

<nav class="flex min-w-0 flex-1 items-end overflow-hidden" aria-label="Workbench tabs">
  <div class="flex min-w-0 w-fit flex-[0_1_auto] items-end">
    <div
      bind:this={tablist}
      class="flex min-w-0 w-max flex-[0_1_auto] items-end overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="tablist"
      aria-label="Open workbench tabs"
      aria-orientation="horizontal"
    >
      {#each tabs as tab, index (tab.id)}
        {@const active = tab.id === activeId}
        <div
          class={[
            "group relative -mb-px h-8 min-w-[120px] w-[220px] flex-[0_1_220px] overflow-hidden rounded-t-sm border transition-colors max-[760px]:w-[200px] max-[760px]:basis-[200px]",
            active
              ? "border-border border-b-background bg-background"
              : "border-transparent hover:bg-chrome-hover",
          ]}
          role="presentation"
          onmousedown={(event) => handleTabMouseDown(event, tab)}
        >
          <button
            use:titlebarDrag
            class={[
              "flex h-full w-full items-center gap-2 bg-transparent pt-0 pb-1.5 pl-3.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-3 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40",
              tab.closable ? "pr-9" : "pr-3.5",
              active && "font-medium text-foreground",
            ]}
            type="button"
            role="tab"
            id={`workbench-tab-${tab.id}`}
            aria-selected={active}
            aria-controls={tab.panelId}
            tabindex={active || (!activeId && index === 0) ? 0 : -1}
            data-workbench-tab
            data-workbench-tab-id={tab.id}
            title={tab.title}
            onclick={() => onSelect(tab.id)}
            onkeydown={(event) => handleTabKeydown(event, index, tab)}
            disabled={tab.selectionDisabled ?? tab.disabled}
          >
            {#if tab.kind === "session"}
              <SessionTabStatusIcon kind={tab.statusKind} {active} />
              {#if tab.fork}
                <GitFork class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {/if}
            {:else if tab.kind === "preview"}
              <FileCode class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            {:else}
              <GitCompareArrows class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            {/if}

            <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{tab.label}</span>

            {#if tab.kind === "preview" && tab.dirty}
              <span class="h-2 w-2 shrink-0 rounded-full bg-foreground/70" title="Unsaved changes" aria-label="Unsaved changes"></span>
            {:else if tab.kind === "diff" && tab.busy}
              <span class="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-tool-info motion-reduce:animate-none" aria-label="Working"></span>
            {/if}
          </button>

          {#if tab.closable}
            <button
              use:titlebarDrag
              class={[
                "absolute top-1/2 right-1.5 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md bg-transparent text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:-outline-offset-3 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40 group-hover:opacity-100 group-focus-within:opacity-100",
                active && "opacity-100",
              ]}
              type="button"
              tabindex="-1"
              aria-label={`Close ${tab.label}`}
              title={tab.kind === "session" && tab.running ? "Close tab and stop running session" : `Close ${tab.label}`}
              onclick={() => void closeAndRestoreFocus(tab.id)}
              disabled={tab.disabled}
            ><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
          {/if}
        </div>
      {/each}
    </div>

    <button
      use:titlebarDrag
      class="mb-0.5 grid h-7 w-6 shrink-0 place-items-center rounded-md bg-transparent text-muted-foreground transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-3 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
      title={newSessionShortcut ? `New conversation · ${newSessionShortcut}` : "New conversation"}
      aria-label="New conversation"
      data-session-new
      onclick={onCreateSession}
      disabled={!canCreateSession}
    ><Plus class="h-4 w-4" aria-hidden="true" /></button>
  </div>

  <div class="min-w-3 flex-1 self-stretch" data-tauri-drag-region></div>
</nav>
