<script lang="ts">
  import Database from "@lucide/svelte/icons/database";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import CircleArrowDown from "@lucide/svelte/icons/circle-arrow-down";
  import CircleArrowUp from "@lucide/svelte/icons/circle-arrow-up";
  import CircleX from "@lucide/svelte/icons/circle-x";
  import CloudOff from "@lucide/svelte/icons/cloud-off";
  import Download from "@lucide/svelte/icons/download";
  import GitCompareArrows from "@lucide/svelte/icons/git-compare-arrows";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import Link2Off from "@lucide/svelte/icons/link-2-off";
  import PackageMinus from "@lucide/svelte/icons/package-minus";
  import PackagePlus from "@lucide/svelte/icons/package-plus";
  import Pencil from "@lucide/svelte/icons/pencil";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Search from "@lucide/svelte/icons/search";
  import Settings from "@lucide/svelte/icons/settings";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Upload from "@lucide/svelte/icons/upload";
  import X from "@lucide/svelte/icons/x";
  import CheckCircle2 from "@lucide/svelte/icons/check-circle-2";
  import {
    registryFriendlyActionLabel,
    registryFriendlyStatusDescription,
    registryFriendlyStatusLabel,
    registryPrimaryAction,
    searchRegistryItems,
    type RegistryActionRequest,
    type RegistryItem,
    type RegistryItemAction,
    type RegistryProjectArtifact,
    type RegistryResourceType,
    type RegistrySnapshot,
    type RegistryStatus,
  } from "../lib/registry";

  type RegistryFilter = "all" | RegistryResourceType;

  let {
    snapshot,
    loading,
    disabled,
    actionId,
    onRefresh,
    onAction,
    onOpenProjectArtifact,
  }: {
    snapshot: RegistrySnapshot | undefined;
    loading: boolean;
    disabled: boolean;
    actionId: string | null;
    onRefresh: () => void;
    onAction: (request: RegistryActionRequest, actionId: string) => void;
    onOpenProjectArtifact: (artifact: RegistryProjectArtifact) => void;
  } = $props();

  let filter = $state<RegistryFilter>("all");
  let query = $state("");
  let projectReviewOpen = $state(false);
  const projectItems = $derived((snapshot?.items ?? []).filter((item) => item.type === "project"));
  const projectPendingItems = $derived(projectItems.filter((item) => item.status !== "up-to-date"));
  const projectConflictCount = $derived(projectItems.filter((item) => item.status === "diverged" || item.status === "registry-changed" || item.status === "untracked-local").length);
  const visibleItems = $derived.by(() => {
    const filtered = (snapshot?.items ?? [])
      .filter((item) => filter === "all" || item.type === filter);
    return searchRegistryItems(filtered, query);
  });
  const busy = $derived(disabled || actionId !== null);

  function iconTone(status: RegistryStatus): string {
    if (status === "up-to-date") return "text-[var(--tool-success)]";
    if (status === "update-available" || status === "missing-local") return "text-[var(--tool-warning)]";
    if (status === "diverged" || status === "registry-changed" || status === "removed-remote") return "text-[var(--tool-error)]";
    if (status === "local-changes" || status === "local-only" || status === "untracked-local") return "text-[var(--tool-info)]";
    return "text-muted-foreground";
  }

  function actionTone(item: RegistryItem, action: RegistryItemAction): string {
    if (action === "remove") {
      return "text-[var(--tool-error)] hover:bg-[var(--tool-error)]/10 hover:text-[var(--tool-error)]";
    }
    if (action === "uninstall") {
      return "text-[var(--tool-warning)] hover:bg-[var(--tool-warning)]/10 hover:text-[var(--tool-warning)]";
    }
    if (item.status === "untracked-local" && (action === "push" || action === "pull")) {
      return "text-[var(--tool-warning)] hover:bg-[var(--tool-warning)]/10 hover:text-[var(--tool-warning)]";
    }
    return "text-muted-foreground hover:bg-accent hover:text-foreground";
  }

  function typeLabel(type: RegistryResourceType): string {
    if (type === "skill") return "SKILL";
    if (type === "agent") return "AGENT";
    return "PROJECT";
  }

  function typeTone(type: RegistryResourceType): string {
    if (type === "skill") {
      return "border-cyan-500/20 bg-cyan-500/5 text-cyan-500";
    }
    if (type === "agent") {
      return "border-violet-500/20 bg-violet-500/5 text-violet-500";
    }
    return "border-slate-400/25 bg-slate-400/5 text-slate-400";
  }

  function requestFor(item: RegistryItem, action: RegistryItemAction): RegistryActionRequest | undefined {
    if (item.type === "project") {
      if (!item.artifact || (action !== "push" && action !== "pull")) return undefined;
      return {
        action: action === "push" ? "push-project" : "pull-project",
        scope: item.artifact,
      };
    }
    if (action === "pull") return undefined;
    return { action, type: item.type, name: item.name };
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
    if (item.artifact === "todo") return "Open/edit TODO.md";
    if (item.artifact === "plans") return "Choose plan to preview/edit";
    return "Open project tasks";
  }
</script>

<section class="flex min-h-0 min-w-0 w-full flex-col overflow-hidden" aria-label="Resource registry">
  <div class="min-w-0 space-y-2 border-b border-sidebar-border p-2.5">
    {#if snapshot?.configured}
      <div class="rounded-lg border border-sidebar-border bg-background/45 p-1.5">
        <button
          class="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
          type="button"
          disabled={busy || !snapshot.projectKey || projectItems.length === 0}
          aria-expanded={projectReviewOpen}
          onclick={() => projectReviewOpen = !projectReviewOpen}
        >
          <span class={["grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold", projectConflictCount > 0 ? "bg-[var(--tool-error)]/10 text-[var(--tool-error)]" : projectPendingItems.length > 0 ? "bg-[var(--tool-warning)]/10 text-[var(--tool-warning)]" : "bg-[var(--tool-success)]/10 text-[var(--tool-success)]"]}>
            {projectConflictCount > 0 ? "!" : projectPendingItems.length}
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[10px] font-semibold text-foreground">{projectPendingItems.length === 0 ? "Project synced" : "Review project sync"}</span>
            <span class="block truncate text-[9px] text-muted-foreground">{projectConflictCount > 0 ? `${projectConflictCount} ${projectConflictCount === 1 ? "item needs" : "items need"} review` : projectPendingItems.length > 0 ? `${projectPendingItems.length} ${projectPendingItems.length === 1 ? "change" : "changes"} to sync` : "Tasks, plans and TODO are up to date"}</span>
          </span>
          <ChevronDown class={["h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", projectReviewOpen ? "rotate-180" : ""]} aria-hidden="true" />
        </button>

        {#if projectReviewOpen}
          <div class="mt-1 space-y-0.5 border-t border-sidebar-border pt-1.5">
            {#each projectItems as item (item.id)}
              {@const projectPrimary = registryPrimaryAction(item)}
              <div class="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5">
                <span class={["grid h-5 w-5 shrink-0 place-items-center", iconTone(item.status)]} title={statusTitle(item)} aria-label={statusTitle(item)} role="img">
                  {#if item.status === "up-to-date"}<CheckCircle2 class="h-3.5 w-3.5" aria-hidden="true" />
                  {:else if item.status === "update-available" || item.status === "missing-local" || item.status === "not-installed"}<CircleArrowDown class="h-3.5 w-3.5" aria-hidden="true" />
                  {:else if item.status === "local-changes" || item.status === "local-only"}<CircleArrowUp class="h-3.5 w-3.5" aria-hidden="true" />
                  {:else if item.status === "diverged"}<TriangleAlert class="h-3.5 w-3.5" aria-hidden="true" />
                  {:else if item.status === "untracked-local"}<GitCompareArrows class="h-3.5 w-3.5" aria-hidden="true" />
                  {:else if item.status === "removed-remote"}<CloudOff class="h-3.5 w-3.5" aria-hidden="true" />
                  {:else if item.status === "registry-changed"}<Link2Off class="h-3.5 w-3.5" aria-hidden="true" />
                  {:else}<CircleX class="h-3.5 w-3.5" aria-hidden="true" />{/if}
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[10px] font-medium text-foreground">{item.name}</span>
                  <span class="block truncate text-[9px] text-muted-foreground">{registryFriendlyStatusLabel(item)}</span>
                </span>
                {#if projectPrimary}
                  <button
                    class={[
                      "grid h-6 w-6 shrink-0 place-items-center rounded-md transition-colors disabled:opacity-40",
                      actionTone(item, projectPrimary),
                    ]}
                    type="button"
                    disabled={busy}
                    title={registryFriendlyActionLabel(item, projectPrimary)}
                    aria-label={registryFriendlyActionLabel(item, projectPrimary)}
                    onclick={() => runItemAction(item, projectPrimary)}
                  >
                    {#if projectPrimary === "pull" || projectPrimary === "update"}
                      <Download class="h-3.5 w-3.5" aria-hidden="true" />
                    {:else}
                      <Upload class="h-3.5 w-3.5" aria-hidden="true" />
                    {/if}
                  </button>
                {:else if item.status !== "up-to-date"}
                  <span class="shrink-0 text-[9px] font-medium text-[var(--tool-warning)]">Review</span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <div class="grid min-w-0 grid-cols-2 gap-1.5">
      <div class="relative min-w-0">
        <label class="sr-only" for="registry-search">Search registry resources</label>
        <Search class="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          id="registry-search"
          class="h-7 w-full min-w-0 rounded-md border border-input bg-background py-0 pr-2 pl-7 text-[10px] text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/30"
          type="search"
          placeholder="Search names…"
          bind:value={query}
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <div class="relative min-w-0">
        <label class="sr-only" for="registry-filter">Registry filter</label>
        <select
          id="registry-filter"
          class="h-7 w-full appearance-none rounded-md border border-input bg-background py-0 pr-7 pl-2.5 text-[10px] font-medium text-foreground shadow-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          bind:value={filter}
        >
          <option value="all">All resources</option>
          <option value="skill">Skills</option>
          <option value="agent">Agents</option>
          <option value="project">Project</option>
        </select>
        <ChevronDown class="pointer-events-none absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      </div>
    </div>
  </div>

  <div class="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-2">
    {#if loading && !snapshot}
      <div class="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground"><RefreshCw class="h-4 w-4 animate-spin" aria-hidden="true" />Checking registry…</div>
    {:else if snapshot && !snapshot.configured}
      <div class="rounded-lg border border-sidebar-border bg-background/50 px-3 py-4 text-center">
        <Database class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <p class="text-xs font-medium text-foreground">Registry is not configured</p>
        <p class="mt-1 text-[10px] leading-4 text-muted-foreground">Connect the private Git repository used for skills, agents, and project state.</p>
        <button class="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[10px] font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" disabled={busy} onclick={() => onAction({ action: "configure" }, "configure")}><Settings class="h-3 w-3" aria-hidden="true" />Configure registry</button>
      </div>
    {:else if !snapshot}
      <div class="px-3 py-8 text-center text-xs text-muted-foreground">Open a ready project session to manage its registry.</div>
    {:else}
      {#if snapshot.error}
        <div class="mb-2 flex items-start gap-2 rounded-lg border border-[var(--tool-error)]/30 bg-[var(--tool-error)]/5 px-2.5 py-2 text-[10px] leading-4 text-[var(--tool-error)]"><X class="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" /><span>{snapshot.error}</span></div>
      {/if}
      {#if snapshot.projectIssue}
        <div class="mb-2 rounded-lg border border-[var(--tool-warning)]/30 bg-[var(--tool-warning)]/5 px-2.5 py-2 text-[10px] leading-4 text-[var(--tool-warning)]">
          <p>{snapshot.projectIssue}</p>
          <button class="mt-2 inline-flex h-6 items-center gap-1.5 rounded-md border border-[var(--tool-warning)]/30 bg-background/50 px-2 text-[9px] font-medium text-foreground hover:bg-accent disabled:opacity-40" type="button" disabled={busy} onclick={() => onAction({ action: "project-key" }, "project-key")}><KeyRound class="h-3 w-3" aria-hidden="true" />Set project key</button>
        </div>
      {/if}
      {#if visibleItems.length === 0}
        <div class="px-3 py-8 text-center text-xs text-muted-foreground">No matching registry resources.</div>
      {:else}
        <div class="min-w-0 space-y-1.5">
          {#each visibleItems as item (item.id)}
            <article class="relative min-w-0 rounded-lg border border-sidebar-border bg-background/55 p-2 shadow-xs">
              <div class="flex min-w-0 items-start gap-2">
                <span
                  class={["mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md bg-muted/50", iconTone(item.status)]}
                  title={statusTitle(item)}
                  aria-label={statusTitle(item)}
                  role="img"
                >
                  {#if item.status === "up-to-date"}<CheckCircle2 class="h-4 w-4" aria-hidden="true" />
                  {:else if item.status === "update-available" || item.status === "missing-local" || item.status === "not-installed"}<CircleArrowDown class="h-4 w-4" aria-hidden="true" />
                  {:else if item.status === "local-changes" || item.status === "local-only"}<CircleArrowUp class="h-4 w-4" aria-hidden="true" />
                  {:else if item.status === "diverged"}<TriangleAlert class="h-4 w-4" aria-hidden="true" />
                  {:else if item.status === "untracked-local"}<GitCompareArrows class="h-4 w-4" aria-hidden="true" />
                  {:else if item.status === "removed-remote"}<CloudOff class="h-4 w-4" aria-hidden="true" />
                  {:else if item.status === "registry-changed"}<Link2Off class="h-4 w-4" aria-hidden="true" />
                  {:else}<CircleX class="h-4 w-4" aria-hidden="true" />{/if}
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 items-center gap-1.5">
                    <strong class="min-w-0 max-w-full truncate text-[11px] font-medium text-foreground" title={item.name}>{item.name}</strong>
                    <span class={[
                      "whitespace-nowrap rounded border px-1 py-px font-mono text-[8px] font-semibold tracking-wide",
                      typeTone(item.type),
                    ]}>{typeLabel(item.type)}</span>
                  </div>
                  <p class={["mt-0.5 text-[9px] font-semibold leading-3.5", iconTone(item.status)]} title={statusTitle(item)}>{registryFriendlyStatusLabel(item)}</p>
                  {#if item.description}<p class="line-clamp-1 text-[9px] leading-3.5 text-muted-foreground/80" title={item.description}>{item.description}</p>{/if}
                </div>
                {#if item.actions.length > 0 || (item.type === "project" && item.local && item.artifact)}
                  <div class="flex shrink-0 items-center gap-0.5">
                    {#if item.type === "project" && item.local && item.artifact}
                      <button
                        class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
                        type="button"
                        disabled={busy}
                        title={projectEditTitle(item)}
                        aria-label={`${projectEditTitle(item)}: ${item.name}`}
                        onclick={() => item.artifact && onOpenProjectArtifact(item.artifact)}
                      >
                        <Pencil class="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    {/if}
                    {#each item.actions as action}
                      {@const actionBusy = actionId === `${item.id}:${action}`}
                      {@const actionLabel = registryFriendlyActionLabel(item, action)}
                      <button
                        class={[
                          "grid h-7 w-7 place-items-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40",
                          actionTone(item, action),
                        ]}
                        type="button"
                        disabled={busy}
                        title={actionLabel}
                        aria-label={`${actionLabel}: ${item.name}`}
                        onclick={() => runItemAction(item, action)}
                      >
                        {#if actionBusy}
                          <RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        {:else if action === "install"}
                          <PackagePlus class="h-3.5 w-3.5" aria-hidden="true" />
                        {:else if action === "pull" || action === "update"}
                          <Download class="h-3.5 w-3.5" aria-hidden="true" />
                        {:else if action === "push"}
                          <Upload class="h-3.5 w-3.5" aria-hidden="true" />
                        {:else if action === "uninstall"}
                          <PackageMinus class="h-3.5 w-3.5" aria-hidden="true" />
                        {:else}
                          <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
                        {/if}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
            </article>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</section>
