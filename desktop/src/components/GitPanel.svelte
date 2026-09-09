<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import GitBranchIcon from "@lucide/svelte/icons/git-branch";
  import GitCommitHorizontal from "@lucide/svelte/icons/git-commit-horizontal";
  import Minus from "@lucide/svelte/icons/minus";
  import Plus from "@lucide/svelte/icons/plus";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import Upload from "@lucide/svelte/icons/upload";
  import X from "@lucide/svelte/icons/x";
  import { onMount } from "svelte";
  import {
    gitChangeCode,
    gitChangeLabel,
    gitChangeLineStats,
    loadGitCommitDraft,
    saveGitCommitDraft,
    stagedGitChanges,
    unstagedGitChanges,
    type GitDiffScope,
    type GitFileChange,
    type GitSnapshot,
  } from "../lib/git";

  let {
    workspace,
    snapshot,
    loading,
    error,
    actionId,
    llmActionId,
    sessionReady,
    onRefresh,
    onOpenDiff,
    onStage,
    onUnstage,
    onCommit,
    onPush,
    onSwitchBranch,
    onCreateBranch,
    onGenerateCommitMessage,
    onReview,
  }: {
    workspace: string;
    snapshot: GitSnapshot | undefined;
    loading: boolean;
    error: string | null;
    actionId: string | null;
    llmActionId: string | null;
    sessionReady: boolean;
    onRefresh: () => void;
    onOpenDiff: (path: string | undefined, scope: GitDiffScope) => void;
    onStage: (path?: string) => void;
    onUnstage: (path?: string) => void;
    onCommit: (message: string) => Promise<boolean>;
    onPush: () => void;
    onSwitchBranch: (branch: string) => void;
    onCreateBranch: (branch: string) => void;
    onGenerateCommitMessage: () => Promise<string | undefined>;
    onReview: (path: string | undefined, scope: GitDiffScope) => void;
  } = $props();

  let commitMessage = $state("");
  let creatingBranch = $state(false);
  let branchName = $state("");
  let commitMessageWorkspace = "";

  const staged = $derived(stagedGitChanges(snapshot));
  const unstaged = $derived(unstagedGitChanges(snapshot));
  const busy = $derived(actionId !== null);
  const llmBusy = $derived(llmActionId !== null);
  const canPush = $derived(Boolean(snapshot && !snapshot.detached && snapshot.branch !== "HEAD"));
  const lineCountFormatter = new Intl.NumberFormat("en-US");

  onMount(() => onRefresh());

  $effect(() => {
    const nextWorkspace = workspace;
    if (nextWorkspace === commitMessageWorkspace) return;
    commitMessageWorkspace = nextWorkspace;
    if (!nextWorkspace) {
      commitMessage = "";
      return;
    }
    commitMessage = loadGitCommitDraft(localStorage, nextWorkspace);
  });

  function persistCommitMessage(message: string, targetWorkspace = workspace): void {
    if (!targetWorkspace) return;
    saveGitCommitDraft(localStorage, targetWorkspace, message);
  }

  function statusTone(change: GitFileChange, scope: Exclude<GitDiffScope, "all">): string {
    const code = gitChangeCode(change, scope);
    if (code === "!") return "text-tool-error";
    if (code === "A" || code === "U") return "text-tool-success";
    if (code === "D") return "text-tool-warning";
    return "text-tool-info";
  }

  function formatLineCount(value: number | undefined): string {
    return lineCountFormatter.format(value ?? 0);
  }

  async function generateCommitMessage(): Promise<void> {
    if (!sessionReady || llmBusy || staged.length === 0) return;
    const requestWorkspace = workspace;
    const generated = await onGenerateCommitMessage();
    if (generated && workspace === requestWorkspace) {
      commitMessage = generated;
      persistCommitMessage(generated, requestWorkspace);
    }
  }

  async function commit(): Promise<void> {
    const message = commitMessage.trim();
    if (!message || busy || staged.length === 0) return;
    const requestWorkspace = workspace;
    if (await onCommit(message)) {
      persistCommitMessage("", requestWorkspace);
      if (workspace === requestWorkspace) commitMessage = "";
    }
  }

  function createBranch(): void {
    const name = branchName.trim();
    if (!name || busy) return;
    onCreateBranch(name);
    branchName = "";
    creatingBranch = false;
  }
</script>

<section class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label="Git source control">
  <div class="space-y-2 border-b border-sidebar-border p-2">
    {#if snapshot}
      <div class="flex min-w-0 items-center gap-1.5">
        <GitBranchIcon class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div class="relative min-w-0 flex-1">
          <label class="sr-only" for="git-branch-select">Current branch</label>
          <select
            id="git-branch-select"
            class="h-7 w-full appearance-none rounded-md border border-input bg-background py-0 pr-7 pl-2 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
            value={snapshot.branch}
            disabled={busy || snapshot.detached}
            onchange={(event) => {
              const branch = event.currentTarget.value;
              if (branch && branch !== snapshot?.branch) onSwitchBranch(branch);
            }}
          >
            {#if snapshot.detached}<option value="HEAD">Detached HEAD</option>{/if}
            {#each snapshot.branches as branch (branch.name)}
              <option value={branch.name}>{branch.name}</option>
            {/each}
          </select>
          <ChevronDown class="pointer-events-none absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        </div>
        <button
          class="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
          type="button"
          title="Create branch"
          aria-label="Create branch"
          disabled={busy}
          onclick={() => creatingBranch = !creatingBranch}
        ><Plus class="h-3.5 w-3.5" aria-hidden="true" /></button>
        <button
          class="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
          type="button"
          title="Refresh Git status"
          aria-label="Refresh Git status"
          disabled={loading || busy}
          onclick={onRefresh}
        ><RefreshCw class={["h-3.5 w-3.5", loading ? "animate-spin" : ""]} aria-hidden="true" /></button>
      </div>

      <div class="flex min-w-0 items-center gap-2 px-0.5 text-[11px] text-muted-foreground">
        <span class="truncate">{snapshot.upstream ?? "No upstream"}</span>
        <span class="ml-auto shrink-0 font-mono">↑{snapshot.ahead} ↓{snapshot.behind}</span>
      </div>

      {#if creatingBranch}
        <form class="flex items-center gap-1" onsubmit={(event) => { event.preventDefault(); createBranch(); }}>
          <input
            class="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/30"
            placeholder="new-branch"
            aria-label="New branch name"
            bind:value={branchName}
          />
          <button class="grid h-7 w-7 place-items-center rounded-md text-tool-success hover:bg-accent disabled:opacity-40" type="submit" disabled={!branchName.trim() || busy} title="Create and switch"><Check class="h-3.5 w-3.5" aria-hidden="true" /></button>
          <button class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" type="button" title="Cancel" onclick={() => { creatingBranch = false; branchName = ""; }}><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
        </form>
      {/if}

      <div class="grid grid-cols-2 gap-1.5">
        <button
          class="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-border bg-background text-[11px] font-medium text-foreground hover:bg-accent disabled:opacity-40"
          type="button"
          disabled={snapshot.changes.length === 0 || !sessionReady || llmBusy}
          title={sessionReady ? "Review all changes with LLM" : "Open a ready session to use LLM review"}
          onclick={() => onReview(undefined, "all")}
        ><Sparkles class={["h-3.5 w-3.5", llmActionId === "review:all" ? "animate-pulse" : ""]} aria-hidden="true" />Review</button>
        <button
          class="inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-border bg-background text-[11px] font-medium text-foreground hover:bg-accent disabled:opacity-40"
          type="button"
          disabled={!canPush || busy}
          onclick={onPush}
          title={snapshot.upstream ? "Push current branch" : "Publish current branch"}
        ><Upload class={["h-3.5 w-3.5", actionId === "push" ? "animate-pulse" : ""]} aria-hidden="true" />{snapshot.upstream ? "Push" : "Publish"}</button>
      </div>
    {:else if loading}
      <div class="flex items-center justify-center gap-1.5 py-3 text-[11px] text-muted-foreground"><RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Reading Git status…</div>
    {/if}

    {#if error}
      <div class="rounded-md border border-tool-error/25 bg-tool-error/5 px-2.5 py-2 text-[11px] leading-4 text-tool-error">{error}</div>
    {/if}
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if snapshot}
      <section aria-label="Staged changes">
        <div class="sticky top-0 z-[1] flex h-7 items-center gap-1 border-b border-sidebar-border bg-chrome px-2">
          <strong class="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Staged Changes</strong>
          <span class="font-mono text-[11px] text-muted-foreground/70">{staged.length}</span>
          {#if staged.length > 0}
            <button class="ml-auto grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40" type="button" title="Unstage all" aria-label="Unstage all" disabled={busy} onclick={() => onUnstage()}><Minus class="h-3.5 w-3.5" aria-hidden="true" /></button>
          {/if}
        </div>
        {#if staged.length === 0}
          <div class="px-3 py-3 text-[11px] text-muted-foreground/70">Stage files to include them in the next commit.</div>
        {:else}
          {#each staged as change (`staged:${change.path}`)}
            {@const stats = gitChangeLineStats(change, "staged")}
            <div class="group flex h-7 min-w-0 items-center px-2 hover:bg-sidebar-accent">
              <button class="flex h-7 min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring" type="button" title={`Review staged diff: ${change.path}`} onclick={() => onOpenDiff(change.path, "staged")}>
                <span class={["w-3 shrink-0 text-center font-mono text-[11px] font-bold", statusTone(change, "staged")]} title={gitChangeLabel(change, "staged")}>{gitChangeCode(change, "staged")}</span>
                <span class="min-w-0 flex-1 truncate text-[11px] text-foreground">{change.path}</span>
              </button>
              {#if stats.additions !== undefined || stats.deletions !== undefined}
                <span class="mr-1 flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums" aria-label={`${stats.additions ?? 0} additions, ${stats.deletions ?? 0} deletions`}>
                  <span class="text-tool-success">+{formatLineCount(stats.additions)}</span>
                  <span class="text-tool-error">−{formatLineCount(stats.deletions)}</span>
                </span>
              {/if}
              <button class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 disabled:opacity-30 group-hover:opacity-100" type="button" disabled={busy} title={`Unstage ${change.path}`} aria-label={`Unstage ${change.path}`} onclick={() => onUnstage(change.path)}><Minus class="h-3 w-3" aria-hidden="true" /></button>
            </div>
          {/each}
        {/if}
      </section>

      <section class="border-t border-sidebar-border" aria-label="Working tree changes">
        <div class="sticky top-0 z-[1] flex h-7 items-center gap-1 border-b border-sidebar-border bg-chrome px-2">
          <strong class="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Changes</strong>
          <span class="font-mono text-[11px] text-muted-foreground/70">{unstaged.length}</span>
          {#if unstaged.length > 0}
            <button class="ml-auto grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40" type="button" title="Stage all" aria-label="Stage all" disabled={busy} onclick={() => onStage()}><Plus class="h-3.5 w-3.5" aria-hidden="true" /></button>
          {/if}
        </div>
        {#if unstaged.length === 0}
          <div class="px-3 py-3 text-[11px] text-muted-foreground/70">No working tree changes.</div>
        {:else}
          {#each unstaged as change (`unstaged:${change.path}`)}
            {@const stats = gitChangeLineStats(change, "unstaged")}
            <div class="group flex h-7 min-w-0 items-center px-2 hover:bg-sidebar-accent">
              <button class="flex h-7 min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring" type="button" title={`Review working tree diff: ${change.path}`} onclick={() => onOpenDiff(change.path, "unstaged")}>
                <span class={["w-3 shrink-0 text-center font-mono text-[11px] font-bold", statusTone(change, "unstaged")]} title={gitChangeLabel(change, "unstaged")}>{gitChangeCode(change, "unstaged")}</span>
                <span class="min-w-0 flex-1 truncate text-[11px] text-foreground">{change.path}</span>
              </button>
              {#if stats.additions !== undefined || stats.deletions !== undefined}
                <span class="mr-1 flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums" aria-label={`${stats.additions ?? 0} additions, ${stats.deletions ?? 0} deletions`}>
                  <span class="text-tool-success">+{formatLineCount(stats.additions)}</span>
                  <span class="text-tool-error">−{formatLineCount(stats.deletions)}</span>
                </span>
              {/if}
              <button class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 disabled:opacity-30 group-hover:opacity-100" type="button" disabled={busy} title={`Stage ${change.path}`} aria-label={`Stage ${change.path}`} onclick={() => onStage(change.path)}><Plus class="h-3 w-3" aria-hidden="true" /></button>
            </div>
          {/each}
        {/if}
      </section>
    {/if}
  </div>

  {#if snapshot}
    <div class="space-y-1.5 border-t border-sidebar-border p-2">
      <div class="relative">
        <textarea
          class="min-h-16 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 pr-9 text-[11px] leading-4 text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
          placeholder={staged.length > 0 ? "Commit message" : "Stage changes before committing"}
          aria-label="Commit message"
          value={commitMessage}
          oninput={(event) => {
            commitMessage = event.currentTarget.value;
            persistCommitMessage(commitMessage);
          }}
          disabled={staged.length === 0 || busy}
        ></textarea>
        <button
          class="absolute top-1 right-1 grid h-7 w-7 place-items-center rounded-md text-primary hover:bg-accent disabled:opacity-30"
          type="button"
          disabled={staged.length === 0 || !sessionReady || llmBusy || busy}
          title={sessionReady ? "Generate commit message with LLM" : "Open a ready session to generate a commit message"}
          aria-label="Generate commit message with LLM"
          onclick={() => void generateCommitMessage()}
        ><Sparkles class={["h-3.5 w-3.5", llmActionId === "commit-message" ? "animate-pulse" : ""]} aria-hidden="true" /></button>
      </div>
      <button
        class="inline-flex h-7 w-full items-center justify-center gap-1.5 rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground hover:brightness-110 disabled:opacity-40"
        type="button"
        disabled={staged.length === 0 || !commitMessage.trim() || busy}
        onclick={() => void commit()}
      ><GitCommitHorizontal class="h-3.5 w-3.5" aria-hidden="true" />{actionId === "commit" ? "Committing…" : "Commit"}</button>
    </div>
  {/if}
</section>
