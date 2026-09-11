<script lang="ts">
  import FileCode from "@lucide/svelte/icons/file-code";
  import GitCompareArrows from "@lucide/svelte/icons/git-compare-arrows";
  import MessageSquare from "@lucide/svelte/icons/message-square";
  import X from "@lucide/svelte/icons/x";
  import { tick } from "svelte";
  import { linearFocusIndex } from "../lib/keyboard-navigation";
  import {
    workspaceEditorCloseFallback,
    type WorkspaceEditorId,
    type WorkspaceEditorTab,
  } from "../lib/workspace-editors";

  let {
    tabs,
    activeId,
    onSelect,
    onClose,
    onFallbackFocus,
  }: {
    tabs: readonly WorkspaceEditorTab[];
    activeId: WorkspaceEditorId;
    onSelect: (id: WorkspaceEditorId) => void;
    onClose: (id: WorkspaceEditorId) => void | Promise<void>;
    onFallbackFocus?: (id: WorkspaceEditorId) => void | Promise<void>;
  } = $props();

  let tablist = $state<HTMLElement | null>(null);

  function focusTab(id: WorkspaceEditorId): void {
    const tab = tablist?.querySelector<HTMLButtonElement>(`[data-workspace-editor-id="${CSS.escape(id)}"]`);
    tab?.focus();
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function handleTabKeydown(event: KeyboardEvent, index: number, tab: WorkspaceEditorTab): void {
    const nextIndex = linearFocusIndex(index, event.key, tabs.length, "horizontal", true);
    if (nextIndex !== null) {
      event.preventDefault();
      const next = tabs[nextIndex];
      if (next) focusTab(next.id);
      return;
    }
    if (event.key !== "Delete" || !tab.closable) return;
    event.preventDefault();
    void closeAndRestoreFocus(tab.id);
  }

  async function closeAndRestoreFocus(id: WorkspaceEditorId): Promise<void> {
    const fallbackId = workspaceEditorCloseFallback(tabs, id);
    await onClose(id);
    await tick();
    const existing = tablist?.querySelector<HTMLButtonElement>(`[data-workspace-editor-id="${CSS.escape(id)}"]`);
    if (existing?.isConnected) {
      existing.focus();
      return;
    }
    const fallback = tablist?.querySelector<HTMLButtonElement>(`[data-workspace-editor-id="${CSS.escape(fallbackId)}"]`);
    if (fallback?.isConnected) {
      focusTab(fallbackId);
      return;
    }
    await onFallbackFocus?.(fallbackId);
  }
</script>

<div
  bind:this={tablist}
  class="flex h-8 min-w-0 items-end overflow-x-auto border-b border-border bg-chrome [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
  role="tablist"
  aria-label="Workspace editors"
  aria-orientation="horizontal"
>
  {#each tabs as tab, index (tab.id)}
    {@const active = tab.id === activeId}
    <div
      class={[
        "group relative -mb-px h-8 min-w-[112px] max-w-[260px] flex-[0_1_220px] overflow-hidden border-r border-border/70",
        active ? "border-b-background bg-background" : "border-b-border bg-chrome hover:bg-chrome-hover",
      ]}
      role="presentation"
    >
      <button
        class={[
          "flex h-full w-full min-w-0 items-center gap-1.5 bg-transparent px-2.5 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-3 focus-visible:outline-ring",
          tab.closable ? "pr-8" : "pr-2.5",
          active && "font-medium text-foreground",
        ]}
        type="button"
        role="tab"
        id={`workspace-editor-tab-${tab.id}`}
        aria-selected={active}
        aria-controls={`workspace-editor-panel-${tab.id}`}
        tabindex={active ? 0 : -1}
        data-workspace-editor-tab
        data-workspace-editor-id={tab.id}
        title={tab.title ?? tab.label}
        onclick={() => onSelect(tab.id)}
        onkeydown={(event) => handleTabKeydown(event, index, tab)}
      >
        {#if tab.kind === "conversation"}
          <MessageSquare class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        {:else if tab.kind === "file"}
          <FileCode class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        {:else}
          <GitCompareArrows class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        {/if}
        <span class="min-w-0 flex-1 truncate">{tab.label}</span>
        {#if tab.dirty}
          <span class="h-2 w-2 shrink-0 rounded-full bg-foreground/70" title="Unsaved changes" aria-label="Unsaved changes"></span>
        {:else if tab.busy}
          <span class="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-tool-info motion-reduce:animate-none" aria-label="Working"></span>
        {/if}
      </button>
      {#if tab.closable}
        <button
          class="absolute top-1/2 right-1 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring group-hover:opacity-100 group-focus-within:opacity-100"
          type="button"
          tabindex="-1"
          title={`Close ${tab.label}`}
          aria-label={`Close ${tab.label}`}
          onclick={() => void closeAndRestoreFocus(tab.id)}
        ><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
      {/if}
    </div>
  {/each}
</div>

