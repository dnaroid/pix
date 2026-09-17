<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Download from "@lucide/svelte/icons/download";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import Archive from "@lucide/svelte/icons/archive";
  import { tick } from "svelte";
  import type { GitSnapshot } from "../lib/git";
  import type { GitPanelWorkflow } from "../lib/git-workflow";
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
  const selectedStash = $derived(stashes.some((stash) => stash.reference === reference) ? reference : stashes[0]?.reference ?? "");
  const button = "inline-flex min-h-7 items-center justify-center gap-1.5 rounded-md border border-border bg-panel-strong px-2 text-xs hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40";
  async function toggleBranch(): Promise<void> { creatingBranch = !creatingBranch; if (creatingBranch) { await tick(); branchInput?.focus(); } }
  async function closeBranch(): Promise<void> {
    creatingBranch = false;
    await tick();
    branchTrigger?.focus();
  }
</script>

<details class="border-t border-sidebar-border bg-panel" ontoggle={(event) => { if (event.currentTarget.open) workflow.onLoadDetails(); }}>
  <summary class="flex h-8 cursor-pointer list-none items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
    <ChevronDown class="h-3.5 w-3.5" aria-hidden="true" />Repository tools
  </summary>
  <div class="space-y-3 px-2 pb-3">
    <div class="grid grid-cols-2 gap-1.5">
      <button class={button} type="button" disabled={busy || !snapshot.remotes.length} title="Fetch all remotes without changing local files" onclick={() => void workflow.onRepositoryAction("fetch")}><RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />Fetch</button>
      <button class={button} type="button" disabled={busy || dirty || snapshot.detached || !snapshot.upstream} title={dirty ? "Commit or stash changes before pulling" : "Pull fast-forward only. Never creates a merge or rebase."} onclick={() => void workflow.onRepositoryAction("pull")}><Download class="h-3.5 w-3.5" aria-hidden="true" />Pull (ff-only)</button>
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
          <div class="relative min-w-0 flex-1">
            <select class="h-7 w-full appearance-none rounded-md border border-input bg-panel-strong pl-2 pr-6 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30" aria-label="Saved stash" value={selectedStash} onchange={(event) => reference = event.currentTarget.value} disabled={busy}>
              {#each stashes as stash (stash.reference)}<option value={stash.reference}>{stash.reference}: {stash.subject}</option>{/each}
            </select>
            <ChevronDown class="pointer-events-none absolute right-1.5 top-2 h-3 w-3 text-muted-foreground" aria-hidden="true" />
          </div>
          <button class={button} type="button" disabled={busy || dirty || !selectedStash} title={dirty ? "Commit or stash changes first" : "Restore this stash and keep the saved copy"} onclick={() => void workflow.onRepositoryAction("stash-apply", selectedStash)}>Restore</button>
        </div>
        <p class="text-xs leading-4 text-muted-foreground">Restore keeps the saved copy. Requires a clean working tree.</p>
      {:else}<p class="text-xs text-muted-foreground">No saved stashes.</p>{/if}
    </section>
    <section aria-label="Recent commits">
      <h3 class="mb-1 text-xs font-medium text-muted-foreground">Recent commits <span class="font-normal">· latest 30</span></h3>
      <ol class="space-y-1.5">
        {#each workflow.details?.history ?? [] as entry (entry.hash)}
          <li title={`${entry.hash}\n${entry.author} · ${entry.date}`}>
            <p class="truncate text-xs text-foreground">{entry.subject}</p>
            <p class="truncate text-xs text-muted-foreground"><span class="font-mono">{entry.shortHash}</span> · {entry.author} · {entry.date.slice(0, 10)}</p>
          </li>
        {:else}<li class="text-xs text-muted-foreground">{workflow.detailsLoading ? "Loading…" : "No commits yet."}</li>{/each}
      </ol>
    </section>
  </div>
</details>
