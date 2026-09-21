<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import Upload from "@lucide/svelte/icons/upload";
  import Wrench from "@lucide/svelte/icons/wrench";
  import Check from "@lucide/svelte/icons/check";
  import { onMount } from "svelte";
  import { gitReviewHasFindings, stagedGitChanges, unstagedGitChanges, type GitDiffScope, type GitSnapshot } from "../lib/git";
  import { gitPushBlockedReason, gitReviewStatus, type GitPanelWorkflow } from "../lib/git-workflow";
  import GitChangesSection from "./GitChangesSection.svelte";
  import GitCommitComposer from "./GitCommitComposer.svelte";
  import GitRepositoryTools from "./GitRepositoryTools.svelte";

  let { workspace, snapshot, uninitialized, loading, error, actionId, llmActionId, gitAssistantReady, workflow,
    onRefresh, onInitialize, onOpenDiff, onStage, onUnstage, onCommit, onPush, onSwitchBranch, onCreateBranch, onGenerateCommitMessage, onReview }: {
    workspace: string; snapshot: GitSnapshot | undefined; uninitialized: boolean; loading: boolean; error: string | null;
    actionId: string | null; llmActionId: string | null; gitAssistantReady: boolean; workflow: GitPanelWorkflow;
    onRefresh: () => void; onInitialize: () => void; onOpenDiff: (path: string | undefined, scope: GitDiffScope) => void;
    onStage: (path?: string) => Promise<boolean>; onUnstage: (path?: string) => void;
    onCommit: (message: string, pushAfterCommit?: boolean) => Promise<boolean>; onPush: () => void;
    onSwitchBranch: (branch: string) => void; onCreateBranch: (branch: string) => void;
    onGenerateCommitMessage: () => Promise<string | undefined>;
    onReview: (path: string | undefined, scope: GitDiffScope) => void;
  } = $props();

  let query = $state("");
  let queryWorkspace: string | undefined;
  $effect(() => {
    if (workspace !== queryWorkspace) {
      query = "";
      queryWorkspace = workspace;
    }
  });
  const staged = $derived(stagedGitChanges(snapshot));
  const unstaged = $derived(unstagedGitChanges(snapshot));
  const busy = $derived(actionId !== null || llmActionId !== null || workflow.resolveRunning);
  const pushBlocked = $derived(gitPushBlockedReason(snapshot));
  const reviewStatus = $derived(gitReviewStatus(workflow.review?.text));
  const findings = $derived(gitReviewHasFindings(workflow.review?.text));
  const reviewLoading = $derived(llmActionId?.startsWith("review:") === true);
  const conflicts = $derived(snapshot?.changes.filter((change) => change.conflicted).length ?? 0);
  onMount(() => onRefresh());
</script>

<section class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-panel" aria-label="Git source control">
  <header class="shrink-0 space-y-1 border-b border-sidebar-border p-2">
    <div class="flex min-w-0 items-center gap-1.5">
      <GitBranch class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      {#if snapshot}
        <div class="relative min-w-0 flex-1">
          <select class="h-7 w-full appearance-none rounded-md border border-input bg-panel-strong pl-2 pr-7 font-mono text-xs text-foreground outline-none hover:bg-panel-hover focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
            aria-label="Current branch" value={snapshot.branch} disabled={busy}
            onchange={(event) => { const branch = event.currentTarget.value; if (branch && branch !== snapshot?.branch) onSwitchBranch(branch); }}>
            {#if snapshot.detached}<option value="HEAD" disabled>Detached HEAD</option>{/if}
            {#each snapshot.branches as branch (branch.name)}<option value={branch.name}>{branch.name}</option>{/each}
          </select>
          <ChevronDown class="pointer-events-none absolute right-2 top-2 h-3 w-3 text-muted-foreground" aria-hidden="true" />
        </div>
      {:else}<span class="flex-1 text-xs font-medium">Source Control</span>{/if}
      <button class="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" title="Refresh Git status" aria-label="Refresh Git status" disabled={loading || busy} onclick={onRefresh}><RefreshCw class={["h-3.5 w-3.5", loading ? "animate-spin" : ""]} aria-hidden="true" /></button>
    </div>
    {#if snapshot}
      <div class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span class="min-w-0 flex-1 truncate" title={snapshot.upstream ?? "No upstream configured"}>{snapshot.upstream ?? "Local branch"}</span>
        <span class="shrink-0 font-mono" title="Outgoing / incoming commits" aria-label={`${snapshot.ahead} outgoing, ${snapshot.behind} incoming commits`}>↑{snapshot.ahead} ↓{snapshot.behind}</span>
        <button class="inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 font-medium text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button"
          disabled={busy || Boolean(pushBlocked) || !snapshot.head || Boolean(snapshot.upstream && snapshot.ahead === 0)}
          title={pushBlocked ?? (snapshot.upstream ? "Push outgoing commits" : "Publish branch and set upstream")} onclick={onPush}>
          <Upload class="h-3 w-3" aria-hidden="true" />{actionId === "push" ? "Pushing…" : snapshot.upstream ? "Push" : "Publish"}
        </button>
      </div>
    {/if}
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if error}<div class="border-b border-tool-error/25 bg-tool-error/5 px-3 py-2 text-xs leading-4 text-tool-error break-words" role="alert">{error}</div>{/if}
    {#if workflow.notice && !error}<div class="border-b border-sidebar-border px-3 py-2 text-xs leading-4 text-tool-success" role="status">{workflow.notice}</div>{/if}
    {#if actionId && actionId !== "push" && actionId !== "commit"}<p class="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground" role="status"><RefreshCw class="h-3 w-3 animate-spin" aria-hidden="true" />Updating repository…</p>{/if}
    {#if snapshot}
      {#if snapshot.behind > 0}<p class="border-b border-tool-warning/20 bg-tool-warning/5 px-3 py-2 text-xs leading-4 text-tool-warning">{snapshot.behind} incoming commit(s). {snapshot.ahead > 0 ? "Branches have diverged. Resolve divergence before pushing." : "Pull from Repository tools before pushing."}</p>{/if}
      {#if conflicts}<p class="border-b border-tool-error/20 bg-tool-error/5 px-3 py-2 text-xs leading-4 text-tool-error" role="status">{conflicts} conflicted file(s). Resolve and stage them before committing.</p>{/if}
      {#if workflow.review || reviewLoading}
        <section class="space-y-2 border-b border-sidebar-border px-2 py-2" aria-label="Code review checkpoint">
          <div class="flex items-center gap-1.5 text-xs">
            {#if reviewLoading}<RefreshCw class="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden="true" />{:else}<ShieldCheck class="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />{/if}
            <strong class="flex-1 font-medium">{reviewLoading ? "Reviewing changes…" : workflow.review?.stale ? "Review is out of date" : reviewStatus === "failed" ? "Review failed" : reviewStatus === "empty" ? "Nothing to review" : findings ? "Review ready · findings" : "Review ready · no findings"}</strong>
            {#if workflow.review}<button class="h-6 rounded-sm px-1.5 text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" type="button" onclick={workflow.onShowReview}>View</button>{/if}
          </div>
          {#if workflow.review && !reviewLoading}
            <p class="text-xs leading-4 text-muted-foreground">{workflow.review.diff.path ?? (workflow.review.diff.scope === "staged" ? "Staged changes" : workflow.review.diff.scope === "unstaged" ? "Working-tree changes" : "All changes")}. {workflow.review.stale ? "Changes moved on. Run review again." : findings ? "Fix in a new session, or commit after inspecting the findings." : reviewStatus === "complete" ? "Generate a message below, then commit and push." : "Run code review again to continue."}</p>
            {#if findings && !workflow.review.stale}
              <button class="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" disabled={!workflow.canResolve || busy} onclick={workflow.onResolve}>
                <Wrench class="h-3.5 w-3.5" aria-hidden="true" />{workflow.resolveRunning ? "Starting session…" : "Fix in new session"}
              </button>
            {/if}
          {/if}
        </section>
      {/if}
      {#if snapshot.changes.length === 0}
        <div class="flex items-start gap-2 px-3 py-5 text-muted-foreground"><Check class="mt-0.5 h-4 w-4 shrink-0 text-tool-success" aria-hidden="true" /><div><p class="text-xs font-medium text-foreground">Working tree clean</p><p class="mt-1 text-xs">{snapshot.ahead ? "Local commits are ready to push." : "No uncommitted changes."}</p></div></div>
      {:else}
        <div class="flex gap-1 px-2 py-2">
          <input type="search" class="h-7 min-w-0 flex-1 rounded-md border border-input bg-panel-strong px-2 text-xs outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/30" aria-label="Filter changed files" placeholder="Filter changed files…" bind:value={query} />
          <button class="shrink-0 rounded-sm px-1.5 text-xs text-muted-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" disabled={!gitAssistantReady || busy || Boolean(conflicts)} title="Review staged, unstaged and untracked changes together" onclick={() => onReview(undefined, "all")}>Review all</button>
        </div>
        <GitChangesSection changes={staged} scope="staged" {query} {busy} {onOpenDiff} onToggle={(path) => onUnstage(path)} onDiscard={() => {}} />
        <GitChangesSection changes={unstaged} scope="unstaged" {query} {busy} {onOpenDiff} onToggle={(path) => void onStage(path)} onDiscard={(path) => void workflow.onRepositoryAction("discard", path)} />
      {/if}
      {#key workspace}<GitRepositoryTools {snapshot} {busy} {workflow} {onCreateBranch} />{/key}
    {:else if uninitialized}
      <div class="px-3 py-8 text-center">
        <GitBranch class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <p class="text-xs font-medium text-foreground">Git is not initialized</p>
        <p class="mx-auto mt-1 max-w-64 text-xs leading-4 text-muted-foreground">Create a repository for this project with <span class="font-mono">main</span> as the initial branch.</p>
        <button class="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" disabled={busy || loading} onclick={onInitialize}>
          {#if actionId === "init"}<RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{:else}<GitBranch class="h-3.5 w-3.5" aria-hidden="true" />{/if}
          {actionId === "init" ? "Initializing…" : "Initialize Git"}
        </button>
      </div>
    {:else if loading}<p class="px-3 py-4 text-xs text-muted-foreground" role="status">Reading Git status…</p>
    {:else if !error}<p class="px-3 py-4 text-xs text-muted-foreground">Open a Git repository to use Source Control.</p>{/if}
  </div>

  {#if snapshot}
    {#key workspace}<GitCommitComposer {workspace} {snapshot} {busy} {llmActionId} {gitAssistantReady} {actionId} {onStage} {onCommit} {onGenerateCommitMessage} {onReview} />{/key}
  {/if}
</section>
