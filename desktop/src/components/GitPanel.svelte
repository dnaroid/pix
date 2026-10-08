<script lang="ts">
  import ArrowDownToLine from "@lucide/svelte/icons/arrow-down-to-line";
  import ArrowUpFromLine from "@lucide/svelte/icons/arrow-up-from-line";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import CloudDownload from "@lucide/svelte/icons/cloud-download";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import Wrench from "@lucide/svelte/icons/wrench";
  import Check from "@lucide/svelte/icons/check";
  import Minus from "@lucide/svelte/icons/minus";
  import X from "@lucide/svelte/icons/x";
  import { onMount } from "svelte";
  import { gitReviewHasFindings, stagedGitChanges, unstagedGitChanges, type GitDiffScope, type GitSnapshot } from "../lib/git";
  import { gitCiAggregate, gitCiStatusLabel, type GitCiPanelState, type GitCiStatus } from "../lib/git-ci";
  import { gitPushBlockedReason, gitReviewStatus, gitUpdateBlockedReason, type GitPanelWorkflow } from "../lib/git-workflow";
  import GitCiSection from "./GitCiSection.svelte";
  import GitChangesSection from "./GitChangesSection.svelte";
  import GitCommitComposer from "./GitCommitComposer.svelte";
  import GitRepositoryTools from "./GitRepositoryTools.svelte";
  import GitIdentitySection from "./GitIdentitySection.svelte";

  let { workspace, snapshot, uninitialized, loading, error, actionId, llmActionId, gitAssistantReady, workflow, ci,
    onRefresh, onInitialize, onOpenDiff, onStage, onUnstage, onCommit, onPush, onSwitchBranch, onCreateBranch, onGenerateCommitMessage, onReview }: {
    workspace: string; snapshot: GitSnapshot | undefined; uninitialized: boolean; loading: boolean; error: string | null;
    actionId: string | null; llmActionId: string | null; gitAssistantReady: boolean; workflow: GitPanelWorkflow; ci: GitCiPanelState;
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
  const updateBlocked = $derived(gitUpdateBlockedReason(snapshot));
  const diverged = $derived(Boolean(snapshot && snapshot.ahead > 0 && snapshot.behind > 0));
  const tool = "inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-sm px-1.5 text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:opacity-40";
  const progressLabel = $derived.by(() => {
    switch (actionId) {
      case "stage-generate-commit-push": return "Staging all & generating commit message…";
      case "commit": return "Committing…";
      case "push": return "Pushing…";
      case "update": return "Updating project…";
      case "fetch": return "Fetching remotes…";
      default: return "Updating repository…";
    }
  });
  const reviewStatus = $derived(gitReviewStatus(workflow.review?.text));
  const findings = $derived(gitReviewHasFindings(workflow.review?.text));
  const reviewLoading = $derived(llmActionId?.startsWith("review:") === true);
  const conflicts = $derived(snapshot?.changes.filter((change) => change.conflicted).length ?? 0);
  const ciStatus = $derived(gitCiAggregate(ci.snapshot));
  const ciLabel = $derived(ci.loading && !ci.snapshot ? "checking" : ci.snapshot?.availability === "ready"
    ? (ci.snapshot.localOnly && ci.snapshot.runs.length === 0 ? "local" : gitCiStatusLabel(ciStatus))
    : ci.snapshot ? "setup" : ci.error ? "error" : "—");
  function ciStatusClass(status: GitCiStatus | undefined): string {
    if (ci.error || ci.snapshot?.availability === "error") return "text-tool-error";
    if (ci.snapshot && ci.snapshot.availability !== "ready") return "text-tool-warning";
    if (status === "success") return "text-tool-success";
    if (status === "failure") return "text-tool-error";
    if (status === "queued" || status === "running") return "text-tool-warning";
    return "text-muted-foreground";
  }
  onMount(() => {
    ci.onActivate();
    onRefresh();
    return () => ci.onDeactivate();
  });
</script>

<section class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sidebar" aria-label="Git source control">
  <header class="shrink-0 border-b border-sidebar-border bg-panel">
    <div class="flex h-9 min-w-0 items-center gap-0.5 pr-1 pl-2" role="toolbar" aria-label="Source Control actions">
      <GitBranch class="mr-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      {#if snapshot}
        <div class="relative mr-1 min-w-0 flex-1">
          <select class="h-6 w-full appearance-none rounded-sm border border-input bg-panel-strong pl-2 pr-6 font-mono text-xs text-foreground outline-none hover:bg-panel-hover focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
            aria-label="Current branch" value={snapshot.branch} disabled={busy}
            onchange={(event) => { const branch = event.currentTarget.value; if (branch && branch !== snapshot?.branch) onSwitchBranch(branch); }}>
            {#if snapshot.detached}<option value="HEAD" disabled>Detached HEAD</option>{/if}
            {#each snapshot.branches as branch (branch.name)}<option value={branch.name}>{branch.name}</option>{/each}
          </select>
          <ChevronDown class="pointer-events-none absolute top-1.5 right-1.5 h-3 w-3 text-muted-foreground" aria-hidden="true" />
        </div>
        <button class={[tool, snapshot.behind > 0 && !diverged && "text-tool-info"]} type="button" aria-label="Update project"
          title={updateBlocked ?? `Update project: fetch and fast-forward ${snapshot.upstream}. Local changes are stashed and restored automatically.`}
          disabled={busy || Boolean(updateBlocked)} onclick={() => void workflow.onRepositoryAction("update")}>
          <ArrowDownToLine class={["h-3.5 w-3.5", actionId === "update" && "animate-pulse"]} aria-hidden="true" />
          {#if snapshot.behind > 0}<span class="font-mono text-xs tabular-nums">{snapshot.behind}</span>{/if}
        </button>
        <button class={tool} type="button" aria-label={snapshot.upstream ? "Push" : "Publish branch"}
          disabled={busy || Boolean(pushBlocked) || !snapshot.head || Boolean(snapshot.upstream && snapshot.ahead === 0)}
          title={pushBlocked ?? (snapshot.upstream ? `Push ${snapshot.ahead} outgoing commit(s)` : "Publish branch and set upstream")} onclick={onPush}>
          <ArrowUpFromLine class={["h-3.5 w-3.5", actionId === "push" && "animate-pulse"]} aria-hidden="true" />
          {#if snapshot.ahead > 0}<span class="font-mono text-xs tabular-nums">{snapshot.ahead}</span>{/if}
        </button>
        <button class={tool} type="button" aria-label="Fetch" title="Fetch all remotes without changing local files"
          disabled={busy || !snapshot.remotes.length} onclick={() => void workflow.onRepositoryAction("fetch")}>
          <CloudDownload class={["h-3.5 w-3.5", actionId === "fetch" && "animate-pulse"]} aria-hidden="true" />
        </button>
      {:else}<span class="flex-1 text-xs font-medium">Source Control</span>{/if}
      <button class={tool} type="button" title="Refresh Git status and check remotes" aria-label="Refresh Git status and check remotes" disabled={loading || busy} onclick={onRefresh}><RefreshCw class={["h-3.5 w-3.5", loading ? "animate-spin" : ""]} aria-hidden="true" /></button>
    </div>
    {#if snapshot}
      <div class="flex h-7 min-w-0 items-center gap-2 border-t border-sidebar-border/60 px-2 text-xs text-muted-foreground">
        <span class="min-w-0 flex-1 truncate font-mono" title={snapshot.upstream ?? "No upstream configured"}>{snapshot.upstream ?? "Local branch · no upstream"}</span>
        {#if snapshot.head}
          <button class={["inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1 hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40", ciStatusClass(ciStatus)]}
            type="button" disabled={ci.loading} title={ci.snapshot?.error ?? ci.error ?? `CI status for ${snapshot.head.slice(0, 8)} · click to refresh`} onclick={ci.onRefresh}>
            {#if ci.loading}<RefreshCw class="h-3 w-3 animate-spin" aria-hidden="true" />
            {:else if ciStatus === "success"}<Check class="h-3 w-3" aria-hidden="true" />
            {:else if ciStatus === "failure"}<X class="h-3 w-3" aria-hidden="true" />
            {:else if ciStatus === "queued" || ciStatus === "running"}<RefreshCw class="h-3 w-3" aria-hidden="true" />
            {:else}<Minus class="h-3 w-3" aria-hidden="true" />{/if}
            CI {ciLabel}
          </button>
        {/if}
      </div>
    {/if}
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if error}<div class="border-b border-tool-error/25 bg-tool-error/5 px-3 py-2 text-xs leading-4 text-tool-error break-words" role="alert">{error}</div>{/if}
    {#if workflow.notice && !error}<div class="border-b border-sidebar-border px-3 py-2 text-xs leading-4 text-tool-success" role="status">{workflow.notice}</div>{/if}
    {#if workflow.selectedCommit}
      <section class="space-y-1.5 border-b border-sidebar-border bg-panel px-3 py-2.5" aria-label="Selected Git commit">
        <div class="flex items-center gap-2 text-xs">
          <strong class="min-w-0 flex-1 truncate font-medium text-foreground" title={workflow.selectedCommit.subject}>{workflow.selectedCommit.subject}</strong>
          <button class="shrink-0 rounded-sm px-1.5 py-1 text-xs font-medium text-primary hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring"
            type="button" onclick={workflow.onShowCommitDiff}>View diff</button>
        </div>
        <p class="break-all font-mono text-xs text-muted-foreground" title={workflow.selectedCommit.hash}>{workflow.selectedCommit.hash}</p>
        <p class="text-xs text-muted-foreground">{workflow.selectedCommit.author} · {workflow.selectedCommit.date}</p>
      </section>
    {/if}
    {#if actionId}<p class="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground" role="status"><RefreshCw class="h-3 w-3 animate-spin" aria-hidden="true" />{progressLabel}</p>{/if}
    {#if snapshot}
      {#if diverged}<p class="border-b border-tool-warning/20 bg-tool-warning/5 px-3 py-2 text-xs leading-4 text-tool-warning">Branch has diverged: {snapshot.ahead} outgoing, {snapshot.behind} incoming. Update only fast-forwards; merge or rebase in a terminal before pushing.</p>
      {:else if snapshot.behind > 0}<p class="border-b border-tool-info/20 bg-tool-info/5 px-3 py-2 text-xs leading-4 text-tool-info">{snapshot.behind} incoming commit(s). Use Update project to fast-forward; local changes are carried over.</p>{/if}
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
        <div class="flex gap-1 border-b border-sidebar-border/60 px-2 py-2">
          <input type="search" class="h-7 min-w-0 flex-1 rounded-md border border-input bg-panel-strong px-2 text-xs outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/30" aria-label="Filter changed files" placeholder="Filter changed files…" bind:value={query} />
          <button class="h-7 shrink-0 rounded-md px-2 text-xs text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" disabled={!gitAssistantReady || busy || Boolean(conflicts)} title="Review staged, unstaged and untracked changes together" onclick={() => onReview(undefined, "all")}>Review all</button>
        </div>
        <GitChangesSection changes={staged} scope="staged" {query} {busy} {onOpenDiff} onToggle={(path) => onUnstage(path)} onDiscard={() => {}} />
        <GitChangesSection changes={unstaged} scope="unstaged" {query} {busy} {onOpenDiff} onToggle={(path) => void onStage(path)} onDiscard={(path) => void workflow.onRepositoryAction("discard", path)} />
      {/if}
      {#if snapshot.head}<GitCiSection {ci} />{/if}
      {#key workspace}<GitRepositoryTools {snapshot} {busy} {workflow} {onCreateBranch} />{/key}
      {#key workspace}<GitIdentitySection {workspace} {busy} onSave={workflow.onSaveIdentity} />{/key}
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
