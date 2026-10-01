<script lang="ts">
  import Bot from "@lucide/svelte/icons/bot";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Database from "@lucide/svelte/icons/database";
  import FolderGit2 from "@lucide/svelte/icons/folder-git-2";
  import Globe from "@lucide/svelte/icons/globe";
  import HardDrive from "@lucide/svelte/icons/hard-drive";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Search from "@lucide/svelte/icons/search";
  import Settings from "@lucide/svelte/icons/settings";
  import WandSparkles from "@lucide/svelte/icons/wand-sparkles";
  import X from "@lucide/svelte/icons/x";
  import {
    registryAttentionCount,
    registryCatalogItems,
    registryDiffAvailable,
    registryFriendlyStatusDescription,
    registryFriendlyStatusLabel,
    registryItemsWithContext,
    registryPublicationScope,
    registryStatusTone,
    searchRegistryItems,
    type RegistryActionRequest,
    type RegistryCatalogSection,
    type RegistryDiffState,
    type RegistryItem,
    type RegistryItemAction,
    type RegistryResourceType,
    type RegistrySnapshot,
  } from "../lib/registry";
  import RegistryItemActions from "./RegistryItemActions.svelte";
  import RegistryStatusIcon from "./RegistryStatusIcon.svelte";
  import type { AvailableCommand } from "@agentclientprotocol/sdk";
  import type { Component } from "svelte";

  const VISIBLE_TAGS = 3;

  type RegistryFilter = "all" | Exclude<RegistryResourceType, "project">;

  let {
    snapshot,
    contextCommands = [],
    loading,
    remoteDisabled,
    actionId,
    diff,
    onAction,
    onDiff,
  }: {
    snapshot: RegistrySnapshot | undefined;
    contextCommands?: readonly AvailableCommand[];
    loading: boolean;
    remoteDisabled: boolean;
    actionId: string | null;
    diff: RegistryDiffState | undefined;
    onAction: (request: RegistryActionRequest, actionId: string) => void;
    onDiff: (item: RegistryItem) => void;
  } = $props();

  let filter = $state<RegistryFilter>("all");
  let catalogSection = $state<RegistryCatalogSection>("installed");
  let query = $state("");

  const catalogItems = $derived(registryItemsWithContext((snapshot?.items ?? []).filter((item) => item.type !== "project"), contextCommands));
  const installedItems = $derived(registryCatalogItems(catalogItems, "installed"));
  const installedCount = $derived(installedItems.length);
  const installedAttentionCount = $derived(registryAttentionCount(installedItems));
  const availableCount = $derived(registryCatalogItems(catalogItems, "available").length);
  const visibleItems = $derived.by(() => {
    const filtered = registryCatalogItems(catalogItems, catalogSection)
      .filter((item) => filter === "all" || item.type === filter);
    return searchRegistryItems(filtered, query);
  });
  const remoteBusy = $derived(remoteDisabled || actionId !== null);

  function typeLabel(type: RegistryResourceType): string {
    if (type === "skill") return "Skill";
    if (type === "agent") return "Agent";
    return "Project";
  }

  function typeIcon(type: RegistryResourceType): Component {
    if (type === "skill") return WandSparkles;
    if (type === "agent") return Bot;
    return HardDrive;
  }

  function typeTone(type: RegistryResourceType): string {
    if (type === "skill") return "text-tool-info";
    if (type === "agent") return "text-primary";
    return "text-muted-foreground";
  }

  function publicationIcon(item: RegistryItem): Component {
    if (!item.remote) return HardDrive;
    return registryPublicationScope(item) === "project" ? FolderGit2 : Globe;
  }

  function publicationLabel(item: RegistryItem): string {
    if (!item.remote) return "Local only";
    return registryPublicationScope(item) === "project" ? "Published · Project" : "Published · Global";
  }

  function visibleTags(item: RegistryItem): readonly string[] {
    return (item.tags ?? []).slice(0, VISIBLE_TAGS);
  }

  function hiddenTagCount(item: RegistryItem): number {
    return Math.max(0, (item.tags?.length ?? 0) - VISIBLE_TAGS);
  }

  function requestFor(item: RegistryItem, action: RegistryItemAction): RegistryActionRequest | undefined {
    if (action === "pull") return undefined;
    return { action, type: item.type as "skill" | "agent", name: item.name };
  }

  function runItemAction(item: RegistryItem, action: RegistryItemAction): void {
    const request = requestFor(item, action);
    if (!request) return;
    onAction(request, `${item.id}:${action}`);
  }

  function diffLoadingFor(item: RegistryItem): boolean {
    return diff?.phase === "loading"
      && diff.target.type === item.type
      && diff.target.name === item.name;
  }

  function statusTitle(item: RegistryItem): string {
    return `${registryFriendlyStatusLabel(item)} — ${registryFriendlyStatusDescription(item)}`;
  }

  function publicationTitle(item: RegistryItem): string {
    if (!item.remote) return "Only in this project";
    return registryPublicationScope(item) === "project"
      ? "Published to the shared Git registry for this project only"
      : "Published to the shared Git registry for every project";
  }

  function emptyCatalogLabel(): string {
    if (query.trim()) return "No matching registry resources.";
    let noun = "resources";
    if (filter === "skill") noun = "skills";
    else if (filter === "agent") noun = "agents";
    return catalogSection === "installed"
      ? `No installed ${noun} in this project.`
      : `No available ${noun} to install from the Git registry.`;
  }
</script>

<div class="min-w-0 space-y-1.5 border-b border-sidebar-border bg-panel p-2">
  <div class="grid min-w-0 grid-cols-2 gap-1 rounded-md border border-input bg-panel-strong p-0.5" role="group" aria-label="Registry catalog view">
    <button
      class={[
        "flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-sm px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
        catalogSection === "installed" ? "bg-panel-selected text-foreground" : "text-muted-foreground hover:bg-panel-hover hover:text-foreground",
      ]}
      type="button"
      aria-label="Installed resources"
      title="Project copies and skills already available to the active session"
      aria-pressed={catalogSection === "installed"}
      onclick={() => catalogSection = "installed"}
    >
      <span class="truncate">Installed</span>
      {#if installedAttentionCount > 0}
        <span
          class="shrink-0 rounded-full bg-tool-warning/20 px-1.5 font-mono text-xs font-semibold tabular-nums text-tool-warning"
          title={`${installedAttentionCount} installed ${installedAttentionCount === 1 ? "item needs" : "items need"} attention`}
        >{installedAttentionCount}</span>
      {/if}
      <span class="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{installedCount}</span>
    </button>
    <button
      class={[
        "flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-sm px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
        catalogSection === "available" ? "bg-panel-selected text-foreground" : "text-muted-foreground hover:bg-panel-hover hover:text-foreground",
      ]}
      type="button"
      aria-label="Available resources"
      title="Published skills and agents not yet installed in this project"
      aria-pressed={catalogSection === "available"}
      onclick={() => catalogSection = "available"}
    >
      <span class="truncate">Available</span>
      <span class="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{availableCount}</span>
    </button>
  </div>

  <div class="grid min-w-0 grid-cols-2 gap-1.5">
    <div class="relative min-w-0">
      <label class="sr-only" for="registry-search">Search registry resources</label>
      <Search class="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <input
        id="registry-search"
        class="h-7 w-full min-w-0 rounded-md border border-input bg-panel-strong py-0 pr-2 pl-7 text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
        type="search"
        placeholder="Search name, description, tags…"
        bind:value={query}
        autocomplete="off"
        spellcheck="false"
      />
    </div>
    <div class="relative min-w-0">
      <label class="sr-only" for="registry-filter">Registry filter</label>
      <select
        id="registry-filter"
        class="h-7 w-full appearance-none rounded-md border border-input bg-panel-strong py-0 pr-7 pl-2.5 text-xs font-medium text-foreground shadow-none hover:bg-panel-hover"
        bind:value={filter}
      >
        <option value="all">All types</option>
        <option value="skill">Skills</option>
        <option value="agent">Agents</option>
      </select>
      <ChevronDown class="pointer-events-none absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
    </div>
  </div>
</div>

<div class="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-1.5">
  {#if loading && !snapshot}
    <div class="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground"><RefreshCw class="h-4 w-4 animate-spin" aria-hidden="true" />Checking registry…</div>
  {:else if !snapshot}
    <div class="px-3 py-8 text-center text-xs text-muted-foreground">Registry data is not loaded yet. Refresh to check this workspace.</div>
  {:else}
    {#if snapshot.error}
      <div class="mb-2 flex items-start gap-2 rounded-md border border-tool-error/30 bg-tool-error/5 px-2.5 py-2 text-xs leading-4 text-tool-error"><X class="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" /><span>{snapshot.error}</span></div>
    {/if}
    {#if !snapshot.configured && catalogSection === "available"}
      <div class="px-3 py-6 text-center">
        <Database class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <p class="text-xs font-medium text-foreground">Shared registry is not connected</p>
        <p class="mt-1 text-xs leading-4 text-muted-foreground">Connect the private Git registry to browse and install shared skills and agents.</p>
        <button class="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-panel-strong px-2.5 text-xs font-medium hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" disabled={remoteBusy} onclick={() => onAction({ action: "configure" }, "configure")}><Settings class="h-3 w-3" aria-hidden="true" />Connect registry</button>
      </div>
    {:else if visibleItems.length === 0}
      <div class="px-3 py-8 text-center text-xs text-muted-foreground">{emptyCatalogLabel()}</div>
    {:else}
      <div class="min-w-0 space-y-2">
        {#each visibleItems as item (item.id)}
        <article class="min-w-0 space-y-1.5 rounded-md bg-panel-strong/40 p-2.5 transition-colors hover:bg-panel-hover">
          <div class="flex min-w-0 items-center gap-1.5" data-registry-row="title">
            {#each [typeIcon(item.type)] as TypeIcon}
              <span class={["grid h-4 w-4 shrink-0 place-items-center", typeTone(item.type)]} title={typeLabel(item.type)} aria-label={typeLabel(item.type)} role="img">
                <TypeIcon class="h-3.5 w-3.5" aria-hidden="true" />
              </span>
            {/each}
            <strong class="min-w-0 truncate text-xs font-medium text-foreground" title={item.name}>{item.name}</strong>
          </div>
          <p class="flex min-h-3.5 min-w-0 items-center gap-1.5 text-xs leading-3.5 text-muted-foreground/80" data-registry-row="description">
            {#if item.description}<span class="min-w-0 flex-1 truncate" title={item.description}>{item.description}</span>{/if}
          </p>
          {#if item.tags?.length}
            <div class="flex min-w-0 flex-wrap items-center gap-1" data-registry-row="tags">
              {#each visibleTags(item) as tag}
                <span class="shrink-0 rounded-full bg-muted/40 px-1.5 py-px text-xs text-muted-foreground">#{tag}</span>
              {/each}
              {#if hiddenTagCount(item) > 0}
                <span class="shrink-0 rounded-full bg-muted/40 px-1.5 py-px text-xs text-muted-foreground" title={item.tags.join(", ")}>+{hiddenTagCount(item)}</span>
              {/if}
            </div>
          {/if}
          <div class="flex min-w-0 items-center justify-between gap-2" data-registry-row="footer">
            <div class="flex min-w-0 items-center gap-1.5">
              <span
                class={["grid h-3.5 w-3.5 shrink-0 place-items-center", registryStatusTone(item.status, item.inContext && !item.local)]}
                title={statusTitle(item)}
                aria-label={statusTitle(item)}
                role="img"
              >
                <RegistryStatusIcon status={item.status} synced={item.inContext && !item.local} />
              </span>
              <span class={["min-w-0 truncate text-xs font-semibold", registryStatusTone(item.status, item.inContext && !item.local)]} title={statusTitle(item)}>{registryFriendlyStatusLabel(item)}</span>
              {#if item.inContext && item.local}
                <span class="shrink-0 text-xs font-medium text-tool-success" title="Available to the active session">In context</span>
              {/if}
              {#each [publicationIcon(item)] as PublicationIcon}
                <span class="grid h-3.5 w-3.5 shrink-0 place-items-center text-muted-foreground" title={publicationTitle(item)} aria-label={publicationLabel(item)} role="img">
                  <PublicationIcon class="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              {/each}
            </div>
            {#if registryDiffAvailable(item) || item.actions.length > 0}
              <RegistryItemActions {item} {remoteDisabled} {actionId} projectKey={snapshot.projectKey}
                diffBusy={diffLoadingFor(item)} onAction={(action) => runItemAction(item, action)}
                onDiff={() => onDiff(item)} />
            {/if}
          </div>
        </article>
        {/each}
      </div>
    {/if}
  {/if}
</div>
