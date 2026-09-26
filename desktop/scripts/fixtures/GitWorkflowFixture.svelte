<script lang="ts">
  import { onMount } from "svelte";
  import GitPanel from "../../src/components/GitPanel.svelte";
  import GitDiffPane from "../../src/components/GitDiffPane.svelte";
  import { gitCommitDraftStorageKey, type GitDiff, type GitDiffScope, type GitSnapshot } from "../../src/lib/git";
  import type { GitCiPanelState, GitCiSnapshot } from "../../src/lib/git-ci";
  import type { GitPanelWorkflow, GitReviewResult } from "../../src/lib/git-workflow";

  // Browser fixture only: real components, deterministic fake Git/ACP callbacks.
  const workspace = "/git-workflow-smoke";
  let version = $state(0);
  let width = $state(316);
  let snapshot = $state<GitSnapshot>(initialSnapshot("partial"));
  let llmActionId = $state<string | null>(null);
  let review = $state<GitReviewResult | null>(null);
  let diff = $state<GitDiff | null>(null);
  let sessionReady = $state(true);
  let gitAssistantReady = $state(true);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let details = $state<GitPanelWorkflow["details"]>(null);
  let ciSnapshot = $state<GitCiSnapshot | undefined>(initialCiSnapshot("partial"));
  let calls: string[] = [];
  let delayGeneration = false;
  let delayReview = false;
  let stageFails = false;
  let pushFails = false;
  let finishGeneration: ((value: string) => void) | undefined;
  let finishReview: ((value: string) => void) | undefined;
  const findings = "## Review findings\n\n### 1. Guard stale completion\n\nThe response in `src/long/path/file.ts` can outlive its workspace. Check the request generation before applying it.\n\n".repeat(8);

  function initialSnapshot(mode: string): GitSnapshot {
    const changes = Array.from({ length: mode === "many" ? 70 : 3 }, (_, index) => ({
      path: index === 0 ? "src/long/path/file.ts" : `src/feature-${index}/another-file-with-a-long-name-${index}.ts`,
      indexStatus: mode === "unstaged" || index > 0 ? "." : "M", worktreeStatus: "M",
      staged: mode !== "unstaged" && index === 0, unstaged: true, untracked: index === 2,
      conflicted: mode === "conflict" && index === 0,
      stagedAdditions: 12, stagedDeletions: 3, unstagedAdditions: 42, unstagedDeletions: 7,
    }));
    return { branch: "feature/git-workflows", detached: false, head: "abc", upstream: "origin/feature/git-workflows", ahead: mode === "clean" ? 1 : 0, behind: 0,
      branches: [{ name: "feature/git-workflows", current: true }, { name: "main", current: false }], remotes: mode === "no-remote" ? [] : ["origin"], changes: mode === "clean" ? [] : changes };
  }

  function initialCiSnapshot(mode: string): GitCiSnapshot {
    if (mode === "no-remote") {
      return { availability: "noRemote", headSha: "abc", localOnly: true, runs: [], error: "No Git remote is configured" };
    }
    return {
      provider: "github", availability: "ready", remoteName: "origin", host: "github.com", project: "pix/fixture",
      headSha: "abc", localOnly: false,
      runs: [{ id: "42", name: "Check", status: "success", rawStatus: "success", headSha: "abc", branch: "feature/git-workflows", url: "https://github.com/pix/fixture/actions/runs/42" }],
    };
  }

  function openDiff(path: string | undefined, scope: GitDiffScope): void {
    calls.push(`diff:${scope}`);
    diff = { path, scope, content: "diff --git a/file.ts b/file.ts\n@@ -1 +1 @@\n-old\n+new", truncated: false };
  }

  async function stage(path?: string): Promise<boolean> {
    calls.push(`stage:${path ?? "all"}`);
    if (stageFails) return false;
    snapshot = { ...snapshot, changes: snapshot.changes.map((change) => !path || path === change.path
      ? { ...change, staged: true, unstaged: false, untracked: false, indexStatus: "M", worktreeStatus: "." } : change) };
    return true;
  }

  async function generate(): Promise<string> {
    calls.push("generate");
    llmActionId = "commit-message";
    const result = delayGeneration ? await new Promise<string>((resolve) => { finishGeneration = resolve; }) : "feat: improve Git workflows";
    llmActionId = null;
    return result;
  }

  async function runReview(path: string | undefined, scope: GitDiffScope): Promise<void> {
    calls.push(`review:${scope}`);
    openDiff(path, scope);
    review = null;
    llmActionId = "review:all";
    const text = delayReview ? await new Promise<string>((resolve) => { finishReview = resolve; }) : findings;
    review = { diff: diff!, text, stale: false };
    llmActionId = null;
  }

  async function commit(message: string, push = false): Promise<boolean> {
    calls.push(`commit:${message}`);
    if (push) calls.push("push");
    snapshot = { ...snapshot, ahead: push && !pushFails ? 0 : 1, changes: snapshot.changes.filter((change) => !change.staged) };
    if (push && pushFails) error = "Commit created, but push failed. Retry Push; do not commit again.";
    else notice = push ? "Committed and pushed successfully." : "Commit created locally. Ready to push.";
    return true;
  }

  const workflow = $derived<GitPanelWorkflow>({
    review, resolveRunning: false, canResolve: sessionReady, notice, details, detailsLoading: false,
    onShowReview: () => { if (review) diff = review.diff; },
    onResolve: () => { calls.push("fix-session"); notice = "Fix session started."; },
    onLoadDetails: () => {
      details = { history: [{ hash: "abc1234", shortHash: "abc1234", subject: "Improve source control", author: "Pix", date: "2026-09-16T10:00:00Z" }],
        stashes: [{ reference: "stash@{0}", subject: "Saved work" }] };
    },
    onRepositoryAction: async (action, target) => { calls.push(`${action}:${target ?? "all"}`); return true; },
  });
  const ci = $derived<GitCiPanelState>({
    snapshot: ciSnapshot, loading: false, error: null,
    jobs: new Map([["42", [{ id: "420", name: "build", status: "success", rawStatus: "success", url: "https://github.com/pix/fixture/actions/jobs/420" }]]]),
    jobsLoading: new Set(), jobsErrors: new Map(),
    onActivate: () => {}, onDeactivate: () => {}, onRefresh: () => calls.push("ci-refresh"), onLoadJobs: (runId) => calls.push(`ci-jobs:${runId}`),
  });

  onMount(() => {
    Object.assign(window, { gitWorkflowSmoke: {
      get calls() { return calls.slice(); },
      reset(mode = "partial") {
        localStorage.removeItem(gitCommitDraftStorageKey(workspace));
        snapshot = initialSnapshot(mode); ciSnapshot = initialCiSnapshot(mode); sessionReady = mode !== "no-session";
        gitAssistantReady = mode !== "disconnected";
        review = null; diff = null; error = null; notice = null; details = null;
        llmActionId = null; delayGeneration = false; delayReview = false; stageFails = false; pushFails = false;
        calls = []; version += 1;
      },
      delayGeneration() { delayGeneration = true; },
      resolveGeneration() { finishGeneration?.("generated response"); },
      delayReview() { delayReview = true; },
      resolveReview() { finishReview?.(findings); },
      stageFails() { stageFails = true; },
      pushFails() { pushFails = true; },
      staleReview() { if (review) review = { ...review, stale: true }; },
      setWidth(value: number) { width = value; },
    } });
  });
</script>

<div class="flex h-screen min-h-0 min-w-0 overflow-hidden bg-background">
  <aside id="git-panel-fixture" class="flex min-h-0 shrink-0 border-r border-border" style:width={`${width}px`}>
    {#key version}
      <GitPanel {workspace} {snapshot} loading={false} {error} actionId={null} {llmActionId} {gitAssistantReady} {workflow} {ci}
        onRefresh={() => {}} onOpenDiff={openDiff} onStage={stage}
        onUnstage={(path) => { calls.push(`unstage:${path ?? "all"}`); }} onCommit={commit}
        onPush={() => calls.push("push")}
        onSwitchBranch={(branch) => { calls.push(`switch:${branch}`); snapshot = { ...snapshot, branch }; }}
        onCreateBranch={(branch) => calls.push(`create:${branch}`)} onGenerateCommitMessage={generate}
        onReview={(path, scope) => void runReview(path, scope)} />
    {/key}
  </aside>
  <main class="flex min-h-0 min-w-0 flex-1">
    {#if diff}
      <GitDiffPane {diff} review={review?.text} reviewStale={review?.stale ?? false} reviewLoading={llmActionId === "review:all"}
        resolveLoading={false} canReview={gitAssistantReady && !llmActionId} canResolve={sessionReady && !review?.stale}
        onReview={() => void runReview(diff?.path, diff!.scope)} onResolve={workflow.onResolve}
        onCopyPrompt={() => { calls.push("copy-prompt"); return true; }} />
    {/if}
  </main>
</div>
