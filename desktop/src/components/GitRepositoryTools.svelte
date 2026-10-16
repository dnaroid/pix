<script lang="ts">
  import { paneDisclosureClass, paneDisclosureSummaryClass } from "../lib/disclosure";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import Archive from "@lucide/svelte/icons/archive";
  import { tick } from "svelte";
  import type { GitSnapshot } from "../lib/git";
  import type { GitPanelWorkflow } from "../lib/git-workflow";
  import TaskFieldSelect from "./TaskFieldSelect.svelte";
  let { snapshot, busy, workflow, onCreateBranch }: {
    snapshot: GitSnapshot; busy: boolean; workflow: GitPanelWorkflow; onCreateBranch: (name: string) => void;
  } = $props();
  let branchName = $state("");
  let branchInput = $state<HTMLInputElement | undefined>();
  let branchTrigger = $state<HTMLButtonElement | undefined>();
  let creatingBranch = $state(false);
  let reference = $state("");
  const dirty = $derived(snapshot.changes.length > 0);
  const conflicted = $derived(snapshot.changes.some((change) => change.conflicted));
  const stashes = $derived(workflow.details?.stashes ?? []);
  const stashOptions = $derived(stashes.map((stash) => ({ value: stash.reference, label: `${stash.reference}: ${stash.subject}` })));
  const selectedStash = $derived(stashes.some((stash) => stash.reference === reference) ? reference : stashes[0]?.reference ?? "");
  const button = "inline-flex min-h-7 items-center justify-center gap-1.5 rounded-md border border-border bg-panel-strong px-2 text-xs hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40";
  async function toggleBranch(): Promise<void> { creatingBranch = !creatingBranch; if (creatingBranch) { await tick(); branchInput?.focus(); } }
  async function closeBranch(): Promise<void> {
    creatingBranch = false;
    await tick();
    branchTrigger?.focus();
  }
</script>

<details class={["group/branches", paneDisclosureClass]} ontoggle={(event) => { if (event.currentTarget.open) workflow.onLoadDetails(); }}>
  <summary class={paneDisclosureSummaryClass}>
    <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform group-open/branches:rotate-90 motion-reduce:transition-none" aria-hidden="true" />Branches &amp; stashes
  </summary>
  <div class="space-y-3 px-2 pb-3">
    <div class="grid grid-cols-2 gap-1.5">
      <button bind:this={branchTrigger} class={button} type="button" disabled={busy} aria-expanded={creatingBranch} onclick={() => void toggleBranch()}><GitBranch class="h-3.5 w-3.5" aria-hidden="true" />New branch</button>
      <button class={button} type="button" disabled={busy || !dirty || conflicted || !snapshot.head} title="Save staged, unstaged and untracked files to stash" onclick={() => void workflow.onRepositoryAction("stash-save")}><Archive class="h-3.5 w-3.5" aria-hidden="true" />Stash all</button>
    </div>
    {#if creatingBranch}
      <form class="flex gap-1" onsubmit={(event) => { event.preventDefault(); if (branchName.trim() && !busy) { onCreateBranch(branchName.trim()); creatingBranch = false; branchName = ""; } }}>
        <input bind:this={branchInput} bind:value={branchName} class="h-7 min-w-0 flex-1 rounded-md border border-input bg-panel-strong px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30" aria-label="New branch name" placeholder="feature/my-change" onkeydown={(event) => { if (event.key === "Escape") { event.stopPropagation(); void closeBranch(); } }} />
        <button class={button} type="submit" disabled={busy || !branchName.trim()}>Create</button>
      </form>
    {/if}
    <section class="space-y-1.5" aria-label="Stashes">
      <div class="flex items-center justify-between text-xs text-muted-foreground"><strong class="font-medium">Saved stashes</strong><button class="rounded-sm px-1 hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" onclick={workflow.onLoadDetails} disabled={workflow.detailsLoading || busy}>Refresh</button></div>
      {#if workflow.detailsLoading && !workflow.details}<p class="text-xs text-muted-foreground" role="status">Loading repository details…</p>
      {:else if stashes.length}
        <div class="flex gap-1">
          <div class="min-w-0 flex-1">
            <TaskFieldSelect
              value={selectedStash}
              options={stashOptions}
              ariaLabel="Saved stash"
              size="sm"
              mono
              disabled={busy}
              searchable={stashOptions.length > 8}
              searchPlaceholder="Search stashes…"
              emptyLabel="No matching stashes"
              onChange={(value) => reference = value}
            />
          </div>
          <button class={button} type="button" disabled={busy || dirty || !selectedStash} title={dirty ? "Commit or stash changes first" : "Restore this stash and keep the saved copy"} onclick={() => void workflow.onRepositoryAction("stash-apply", selectedStash)}>Restore</button>
        </div>
        <p class="text-xs leading-4 text-muted-foreground">Restore keeps the saved copy. Requires a clean working tree.</p>
      {:else}<p class="text-xs text-muted-foreground">No saved stashes.</p>{/if}
    </section>
  </div>
</details>

<details class={["group/log", paneDisclosureClass]} ontoggle={(event) => { if (event.currentTarget.open) workflow.onLoadDetails(); }}>
  <summary class={paneDisclosureSummaryClass}>
    <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform group-open/log:rotate-90 motion-reduce:transition-none" aria-hidden="true" />Log
    <span class="ml-auto font-normal">latest 30</span>
  </summary>
  <section class="px-2 pb-3" aria-label="Recent commits">
    <ol>
      {#each workflow.details?.history ?? [] as entry (entry.hash)}
        <li class="min-w-0" title={`${entry.hash}\n${entry.subject}\n${entry.author} · ${entry.date}`}>
          <button class="flex h-6 w-full min-w-0 items-center gap-2 rounded-sm text-left text-xs hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring"
            type="button" aria-label={`View diff for commit ${entry.shortHash}: ${entry.subject}`}
            onclick={() => workflow.onOpenCommit(entry.hash)}>
            <span class="shrink-0 font-mono text-muted-foreground">{entry.shortHash}</span>
            <span class="min-w-0 flex-1 truncate text-foreground">{entry.subject}</span>
            <span class="shrink-0 text-muted-foreground tabular-nums">{entry.date.slice(0, 10)}</span>
          </button>
        </li>
      {:else}<li class="text-xs text-muted-foreground">{workflow.detailsLoading ? "Loading…" : "No commits yet."}</li>{/each}
    </ol>
  </section>
</details>
