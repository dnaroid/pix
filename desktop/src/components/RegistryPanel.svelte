<script lang="ts">
  import Database from "@lucide/svelte/icons/database";
  import Download from "@lucide/svelte/icons/download";
  import MoreHorizontal from "@lucide/svelte/icons/ellipsis";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Settings from "@lucide/svelte/icons/settings";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Upload from "@lucide/svelte/icons/upload";
  import X from "@lucide/svelte/icons/x";
  import {
    registryActionLabel,
    registryPrimaryAction,
    type RegistryActionRequest,
    type RegistryItem,
    type RegistryItemAction,
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
  }: {
    snapshot: RegistrySnapshot | undefined;
    loading: boolean;
    disabled: boolean;
    actionId: string | null;
    onRefresh: () => void;
    onAction: (request: RegistryActionRequest, actionId: string) => void;
  } = $props();

  let filter = $state<RegistryFilter>("all");
  let menuId = $state<string | null>(null);
  const visibleItems = $derived((snapshot?.items ?? []).filter((item) => filter === "all" || item.type === filter));
  const busy = $derived(disabled || actionId !== null);

  function statusTone(status: RegistryStatus): string {
    if (status === "up-to-date") return "border-[var(--tool-success)]/35 bg-[var(--tool-success)]/10 text-[var(--tool-success)]";
    if (status === "update-available" || status === "missing-local") return "border-[var(--tool-warning)]/35 bg-[var(--tool-warning)]/10 text-[var(--tool-warning)]";
    if (status === "diverged" || status === "registry-changed") return "border-[var(--tool-error)]/35 bg-[var(--tool-error)]/10 text-[var(--tool-error)]";
    if (status === "local-changes" || status === "local-only" || status === "untracked-local") return "border-[var(--tool-info)]/35 bg-[var(--tool-info)]/10 text-[var(--tool-info)]";
    if (status === "removed-remote") return "border-[var(--tool-error)]/25 bg-[var(--tool-error)]/5 text-[var(--tool-error)]";
    return "border-border bg-muted text-muted-foreground";
  }

  function iconTone(status: RegistryStatus): string {
    if (status === "up-to-date") return "text-[var(--tool-success)]";
    if (status === "update-available" || status === "missing-local") return "text-[var(--tool-warning)]";
    if (status === "diverged" || status === "registry-changed" || status === "removed-remote") return "text-[var(--tool-error)]";
    if (status === "local-changes" || status === "local-only" || status === "untracked-local") return "text-[var(--tool-info)]";
    return "text-muted-foreground";
  }

  function typeLabel(type: RegistryResourceType): string {
    if (type === "skill") return "SKILL";
    if (type === "agent") return "AGENT";
    return "PROJECT";
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
    menuId = null;
    onAction(request, `${item.id}:${action}`);
  }

  function runProjectAction(action: "push-project" | "pull-project"): void {
    onAction({ action, scope: "project" }, `project:${action}`);
  }

  function destructiveActions(item: RegistryItem): RegistryItemAction[] {
    return item.actions.filter((action) => action === "uninstall" || action === "remove");
  }

  function statusHint(item: RegistryItem): string | undefined {
    if (item.status === "diverged") return "Local and registry copies both changed. Resolve the conflict before syncing.";
    if (item.status === "registry-changed") return "This local copy is tracked from a different registry, branch, or project key.";
    return undefined;
  }
</script>

<section class="flex min-h-0 min-w-0 w-full flex-col overflow-hidden" aria-label="Resource registry">
  <div class="min-w-0 space-y-2 border-b border-sidebar-border p-2.5">
    <div class="flex min-w-0 items-center gap-2">
      <div class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-sidebar-border bg-background/60">
        <Database class="h-3.5 w-3.5 text-primary" aria-hidden="true" />
      </div>
      <div class="min-w-0 flex-1">
        <div class="text-[11px] font-semibold text-foreground">Resource registry</div>
        {#if snapshot?.remote}
          <div class="truncate font-mono text-[9px] text-muted-foreground" title={snapshot.remote}>{snapshot.remote}</div>
        {:else}
          <div class="text-[9px] text-muted-foreground">Private Git-backed resources</div>
        {/if}
      </div>
      <button
        class="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
        type="button"
        title="Configure registry"
        aria-label="Configure registry"
        onclick={() => onAction({ action: "configure" }, "configure")}
        disabled={busy}
      ><Settings class="h-3.5 w-3.5" aria-hidden="true" /></button>
      <button
        class="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
        type="button"
        title="Refresh registry"
        aria-label="Refresh registry"
        onclick={onRefresh}
        disabled={busy}
      ><RefreshCw class={["h-3.5 w-3.5", loading || actionId === "refresh" ? "animate-spin" : ""]} aria-hidden="true" /></button>
    </div>

    {#if snapshot?.configured}
      <div class="rounded-lg border border-sidebar-border bg-background/45 px-2.5 py-2 text-[9px] leading-3.5 text-muted-foreground">
        <div class="flex gap-1.5"><span class="shrink-0">Branch</span><strong class="min-w-0 truncate font-mono font-medium text-foreground">{snapshot.branch}</strong></div>
        <div class="mt-0.5 flex gap-1.5"><span class="shrink-0">Project</span><strong class="min-w-0 truncate font-mono font-medium text-foreground">{snapshot.projectKey ?? "unavailable"}</strong></div>
      </div>
      <div class="grid min-w-0 grid-cols-2 gap-1.5">
        <button class="flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-md border border-border bg-card px-1 text-[10px] font-medium hover:bg-accent disabled:opacity-40" type="button" disabled={busy || !snapshot.projectKey} onclick={() => runProjectAction("push-project")}><Upload class="h-3 w-3 shrink-0" aria-hidden="true" /><span class="truncate">Push project</span></button>
        <button class="flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-md border border-border bg-card px-1 text-[10px] font-medium hover:bg-accent disabled:opacity-40" type="button" disabled={busy || !snapshot.projectKey} onclick={() => runProjectAction("pull-project")}><Download class="h-3 w-3 shrink-0" aria-hidden="true" /><span class="truncate">Pull project</span></button>
      </div>
    {/if}

    <div class="grid min-w-0 grid-cols-4 gap-1" aria-label="Registry filter">
      {#each [["all", "All"], ["skill", "Skills"], ["agent", "Agents"], ["project", "Project"]] as option}
        <button
          class={["h-6 rounded-md px-1 text-[9px] font-medium focus-visible:outline-2 focus-visible:outline-ring", filter === option[0] ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"]}
          type="button"
          onclick={() => filter = option[0] as RegistryFilter}
        >{option[1]}</button>
      {/each}
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
            {@const primary = registryPrimaryAction(item)}
            {@const destructive = destructiveActions(item)}
            {@const hint = statusHint(item)}
            {@const itemBusy = actionId?.startsWith(`${item.id}:`) === true}
            <article class="relative min-w-0 rounded-lg border border-sidebar-border bg-background/55 p-2.5 shadow-xs">
              <div class="flex min-w-0 items-start gap-2">
                <span class={["mt-0.5 w-3 shrink-0 text-center font-mono text-xs font-bold", iconTone(item.status)]} aria-hidden="true">{item.icon}</span>
                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                    <strong class="min-w-0 max-w-full truncate text-[11px] font-medium text-foreground" title={item.name}>{item.name}</strong>
                    <span class="whitespace-nowrap rounded border border-border bg-muted px-1 py-px font-mono text-[8px] font-semibold tracking-wide text-muted-foreground">{typeLabel(item.type)}</span>
                    <span class={["whitespace-nowrap rounded border px-1 py-px text-[8px] font-bold tracking-wide", statusTone(item.status)]}>{item.statusLabel}</span>
                  </div>
                  {#if item.description}<p class="mt-1 line-clamp-2 text-[9px] leading-3.5 text-muted-foreground">{item.description}</p>{/if}
                  {#if hint}<p class="mt-1 text-[9px] leading-3.5 text-[var(--tool-warning)]">{hint}</p>{/if}
                </div>
                <div class="flex shrink-0 items-center gap-0.5">
                  {#if primary}
                    <button
                      class="h-6 rounded-md border border-border bg-card px-2 text-[9px] font-medium text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
                      type="button"
                      disabled={busy}
                      onclick={() => runItemAction(item, primary)}
                    >
                      {#if itemBusy}<RefreshCw class="mr-1 inline h-2.5 w-2.5 animate-spin" aria-hidden="true" />{/if}{registryActionLabel(primary)}
                    </button>
                  {/if}
                  {#if destructive.length > 0}
                    <button
                      class="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
                      type="button"
                      aria-label={`More actions for ${item.name}`}
                      title="More actions"
                      disabled={busy}
                      onclick={() => menuId = menuId === item.id ? null : item.id}
                    ><MoreHorizontal class="h-3.5 w-3.5" aria-hidden="true" /></button>
                  {/if}
                </div>
              </div>

              {#if menuId === item.id && destructive.length > 0}
                <div class="absolute top-9 right-2 z-20 min-w-36 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
                  {#each destructive as action}
                    <button
                      class="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[10px] hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                      class:text-[var(--tool-error)]={action === "remove"}
                      type="button"
                      onclick={() => runItemAction(item, action)}
                    ><Trash2 class="h-3 w-3" aria-hidden="true" />{registryActionLabel(action)}</button>
                  {/each}
                </div>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</section>
