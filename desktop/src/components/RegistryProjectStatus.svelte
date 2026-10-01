<script lang="ts">
  import CircleArrowDown from "@lucide/svelte/icons/circle-arrow-down";
  import CircleArrowUp from "@lucide/svelte/icons/circle-arrow-up";
  import EllipsisVertical from "@lucide/svelte/icons/ellipsis-vertical";
  import FolderPlus from "@lucide/svelte/icons/folder-plus";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import Pencil from "@lucide/svelte/icons/pencil";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import {
    registryFriendlyActionLabel,
    registryFriendlyStatusLabel,
    registryFriendlyStatusDescription,
    registryPrimaryAction,
    registryStatusTone,
    type RegistryActionRequest,
    type RegistryItem,
    type RegistryItemAction,
    type RegistryProjectArtifact,
    type RegistrySnapshot,
  } from "../lib/registry";
  import RegistryStatusIcon from "./RegistryStatusIcon.svelte";
  import type { RegistryBackgroundSyncState } from "../lib/registry-background-sync";
  import { registryProjectSyncPresentation } from "../lib/registry-project-sync";

  let {
    snapshot,
    backgroundSync,
    projectInitialized,
    projectPiSizeBytes,
    projectPiCleanupBytes,
    projectPiCleanupAvailable,
    projectPiStorageLoading,
    projectPiStorageError,
    actionId,
    remoteBusy,
    onInitializeProject,
    onCleanProject,
    onAction,
    onOpenProjectArtifact,
  }: {
    snapshot: RegistrySnapshot | undefined;
    backgroundSync: RegistryBackgroundSyncState;
    projectInitialized: boolean | undefined;
    projectPiSizeBytes: number | null | undefined;
    projectPiCleanupBytes: number | undefined;
    projectPiCleanupAvailable: boolean;
    projectPiStorageLoading: boolean;
    projectPiStorageError: string | null;
    actionId: string | null;
    remoteBusy: boolean;
    onInitializeProject: () => void;
    onCleanProject: () => void;
    onAction: (request: RegistryActionRequest, actionId: string) => void;
    onOpenProjectArtifact: (artifact: RegistryProjectArtifact) => void;
  } = $props();

  let menuOpen = $state(false);
  let menuRoot = $state<HTMLElement | null>(null);

  const projectItems = $derived((snapshot?.items ?? []).filter((item) => item.type === "project"));
  const projectKeyRequired = $derived(Boolean(snapshot?.projectIssue && !snapshot?.projectKey));
  const projectSync = $derived(registryProjectSyncPresentation(projectItems, backgroundSync, snapshot?.error, projectKeyRequired));
  // Routine local writes sync automatically; only genuine review states expand the row.
  const attentionItems = $derived(projectItems.filter((item) =>
    item.status !== "up-to-date" && item.status !== "local-only" && item.status !== "local-changes"
  ));
  const expanded = $derived(projectSync.needsReview && attentionItems.length > 0);

  function requestFor(item: RegistryItem, action: RegistryItemAction): RegistryActionRequest | undefined {
    if (!item.artifact || (action !== "push" && action !== "pull")) return undefined;
    return { action: action === "push" ? "push-project" : "pull-project", scope: item.artifact };
  }

  function runItemAction(item: RegistryItem, action: RegistryItemAction): void {
    const request = requestFor(item, action);
    if (!request) return;
    onAction(request, `${item.id}:${action}`);
  }

  function statusTitle(item: RegistryItem): string {
    return `${registryFriendlyStatusLabel(item)} — ${registryFriendlyStatusDescription(item)}`;
  }

  function projectEditTitle(item: RegistryItem): string {
    if (item.artifact === "workspace") return "Open project settings";
    if (item.artifact === "todo") return "Open/edit TODO.md";
    if (item.artifact === "plans") return "Choose plan to preview/edit";
    return "Open project tasks";
  }

  function formatPiSize(bytes: number | null | undefined): string {
    if (bytes === undefined) return "Unavailable";
    if (bytes === null) return "Not present";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let value = bytes / 1024;
    let unit = units[0];
    for (let index = 1; index < units.length && value >= 1024; index += 1) {
      value /= 1024;
      unit = units[index];
    }
    const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(digits)} ${unit}`;
  }

  function storageSummary(): string {
    if (projectPiStorageLoading && projectPiSizeBytes === undefined) return "Checking… total";
    if (projectPiStorageError) return projectPiStorageError;
    const total = `${formatPiSize(projectPiSizeBytes)} total`;
    return projectPiCleanupBytes !== undefined ? `${total} · ${formatPiSize(projectPiCleanupBytes)} reclaimable` : total;
  }

  function cleanProjectPi(): void {
    menuOpen = false;
    if (actionId !== null || projectPiStorageLoading || projectPiStorageError || !projectPiCleanupAvailable) return;
    const confirmed = window.confirm(
      `Clean ${formatPiSize(projectPiCleanupBytes)} from .pi? This clears all contents of artifacts/ and subagents/ and removes non-canonical top-level files and directories. Canonical project state, config, agents/, plans/, skills/ and task-attachments/ are preserved.`,
    );
    if (confirmed) onCleanProject();
  }

  $effect(() => {
    if (!menuOpen) return;
    const outside = (event: Event) => {
      if (!menuRoot?.contains(event.target as Node)) menuOpen = false;
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  });
</script>

<div class="min-w-0 space-y-1.5 border-b border-sidebar-border bg-panel p-2" bind:this={menuRoot}>
  {#if projectInitialized === false}
    <div class="flex min-w-0 items-center gap-2 px-1 py-1">
      <span class="grid h-6 w-6 shrink-0 place-items-center text-muted-foreground">
        <FolderPlus class="h-4 w-4" aria-hidden="true" />
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-xs font-semibold text-foreground">Project sync is not initialized</span>
        <span class="block truncate text-xs text-muted-foreground">Tasks, plans and attachments need the project scaffold</span>
      </span>
      <button
        class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-panel-strong px-2 text-xs font-medium text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
        type="button"
        disabled={actionId !== null}
        onclick={onInitializeProject}
      >
        {#if actionId === "initialize-project"}
          <RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Initializing…
        {:else}
          Initialize
        {/if}
      </button>
    </div>
  {:else if snapshot?.configured}
    <div class="flex min-w-0 items-center gap-2 px-1 py-1">
      <span class={["grid h-5 w-5 shrink-0 place-items-center", projectSync.needsReview ? "text-tool-warning" : "text-tool-success"]}>
        <RegistryStatusIcon status={attentionItems[0]?.status ?? "up-to-date"} synced={!projectSync.needsReview} class="h-4 w-4" />
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-xs font-semibold text-foreground">{projectSync.title}</span>
        <span class="block truncate text-xs text-muted-foreground">{projectSync.description}</span>
      </span>
      {#if projectKeyRequired}
        <button
          class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-tool-warning/30 bg-panel-strong px-2 text-xs font-medium text-foreground hover:bg-panel-hover disabled:opacity-40"
          type="button"
          disabled={remoteBusy}
          onclick={() => onAction({ action: "project-key" }, "project-key")}
        >
          <KeyRound class="h-3 w-3" aria-hidden="true" />
          Set key
        </button>
      {/if}
      <div class="relative shrink-0">
        <button
          class="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Project housekeeping"
          title="Project housekeeping"
          onclick={() => menuOpen = !menuOpen}
        >
          <EllipsisVertical class="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        {#if menuOpen}
          <div role="menu" aria-label="Project housekeeping" class="absolute right-0 top-7 z-50 w-56 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
            <div class="px-2 py-1.5 text-xs text-muted-foreground" title={projectPiStorageError ?? undefined}>.pi storage · {storageSummary()}</div>
            <button
              role="menuitem"
              type="button"
              class="flex min-h-7 w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs text-tool-error hover:bg-tool-error/10 disabled:opacity-40"
              disabled={actionId !== null || projectPiStorageLoading || Boolean(projectPiStorageError) || !projectPiCleanupAvailable}
              onclick={cleanProjectPi}
            >
              {#if actionId === "cleanup-project"}
                <RefreshCw class="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
                Cleaning…
              {:else}
                <Trash2 class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Clean .pi
              {/if}
            </button>
          </div>
        {/if}
      </div>
    </div>

    {#if expanded}
      <div class="space-y-0.5 border-t border-sidebar-border/70 pt-1.5">
        {#each attentionItems as item (item.id)}
          {@const projectPrimary = registryPrimaryAction(item)}
          <div class="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5">
            <span class={["grid h-5 w-5 shrink-0 place-items-center", registryStatusTone(item.status)]} title={statusTitle(item)} aria-label={statusTitle(item)} role="img">
              <RegistryStatusIcon status={item.status} />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-xs font-medium text-foreground">{item.name}</span>
              <span class="block truncate text-xs text-muted-foreground">{registryFriendlyStatusLabel(item)}</span>
            </span>
            {#if item.local && item.artifact}
              <button
                class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                type="button"
                title={projectEditTitle(item)}
                aria-label={`${projectEditTitle(item)}: ${item.name}`}
                onclick={() => item.artifact && onOpenProjectArtifact(item.artifact)}
              >
                <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            {/if}
            {#if projectPrimary}
              <button
                class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                type="button"
                disabled={remoteBusy}
                title={registryFriendlyActionLabel(item, projectPrimary)}
                aria-label={registryFriendlyActionLabel(item, projectPrimary)}
                onclick={() => runItemAction(item, projectPrimary)}
              >
                {#if projectPrimary === "pull" || projectPrimary === "update"}
                  <CircleArrowDown class="h-3.5 w-3.5" aria-hidden="true" />
                {:else}
                  <CircleArrowUp class="h-3.5 w-3.5" aria-hidden="true" />
                {/if}
              </button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>
