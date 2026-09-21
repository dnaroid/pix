<script lang="ts">
  import GitCommitHorizontal from "@lucide/svelte/icons/git-commit-horizontal";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Upload from "@lucide/svelte/icons/upload";
  import { onDestroy, onMount, tick } from "svelte";
  import { loadGitCommitDraft, saveGitCommitDraft, stagedGitChanges, type GitSnapshot, type GitDiffScope } from "../lib/git";
  import { gitPushBlockedReason } from "../lib/git-workflow";
  import { autosizeTextarea } from "../lib/textarea";

  let { workspace, snapshot, busy, llmActionId, gitAssistantReady, actionId, onStage, onCommit, onGenerateCommitMessage, onReview }: {
    workspace: string; snapshot: GitSnapshot; busy: boolean; llmActionId: string | null;
    gitAssistantReady: boolean; actionId: string | null;
    onStage: (path?: string) => Promise<boolean>;
    onCommit: (message: string, pushAfterCommit?: boolean) => Promise<boolean>;
    onGenerateCommitMessage: () => Promise<string | undefined>;
    onReview: (path: string | undefined, scope: GitDiffScope) => void;
  } = $props();

  let message = $state("");
  let generating = $state(false);
  let submitting = $state(false);
  let draftNotice = $state("");
  let messageTextarea = $state<HTMLTextAreaElement>();
  let draftVersion = 0;
  let disposed = false;
  const staged = $derived(stagedGitChanges(snapshot).length);
  const conflicts = $derived(snapshot.changes.some((change) => change.conflicted));
  const pushBlocked = $derived(gitPushBlockedReason(snapshot));
  const locked = $derived(busy || submitting || generating || llmActionId !== null);
  const canCommit = $derived(staged > 0 && Boolean(message.trim()) && !locked && !conflicts);
  const canPrepare = $derived(gitAssistantReady && !locked && snapshot.changes.length > 0 && !conflicts);
  const reviewScope = $derived(staged > 0 ? "staged" : "all");
  const commitHint = $derived(conflicts ? "Resolve conflicts before committing" : staged === 0
    ? "Stage files or use Stage all & generate" : !message.trim() ? "Write or generate a commit message" : "Commit staged changes only");

  onMount(() => {
    message = loadGitCommitDraft(localStorage, workspace);
    void syncMessageTextareaHeight();
  });
  onDestroy(() => { disposed = true; });

  async function syncMessageTextareaHeight(): Promise<void> {
    await tick();
    if (!disposed && messageTextarea) {
      autosizeTextarea(messageTextarea, { minHeight: 64, maxHeight: 160 });
    }
  }

  function edit(value: string): void {
    message = value;
    draftVersion += 1;
    draftNotice = "";
    saveGitCommitDraft(localStorage, workspace, value);
    void syncMessageTextareaHeight();
  }

  async function generate(): Promise<void> {
    if (!canPrepare) return;
    const version = draftVersion;
    generating = true;
    draftNotice = "";
    try {
      // Explicitly labelled when this action includes all working-tree files.
      if (staged === 0 && !(await onStage())) return;
      if (disposed) return;
      const result = await onGenerateCommitMessage();
      if (disposed || !result) return;
      if (version !== draftVersion) {
        draftNotice = "Your edited message was kept. Generate again to replace it.";
        return;
      }
      edit(result);
    } finally {
      if (!disposed) generating = false;
    }
  }

  async function commit(push: boolean): Promise<void> {
    if (!canCommit || (push && pushBlocked)) return;
    const submitted = message;
    submitting = true;
    try {
      if (await onCommit(submitted.trim(), push)) {
        // Clear only the submitted draft; another mounted panel may own a newer one.
        if (loadGitCommitDraft(localStorage, workspace) === submitted) saveGitCommitDraft(localStorage, workspace, "");
        if (!disposed && message === submitted) {
          message = "";
          void syncMessageTextareaHeight();
        }
      }
    } finally {
      if (!disposed) submitting = false;
    }
  }
</script>

<section class="shrink-0 space-y-2 border-t border-sidebar-border bg-panel p-2" aria-label="Prepare and commit changes">
  <div class="grid grid-cols-2 gap-1.5">
    <button class="inline-flex min-h-8 items-center justify-center gap-1 rounded-md border border-border bg-panel-strong px-1.5 text-xs font-medium hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
      type="button" disabled={!canPrepare} onclick={() => void generate()}
      title={!gitAssistantReady ? "Connect to generate a message" : staged ? `Generate from ${staged} staged files only` : `Stage all ${snapshot.changes.length} changed files, then generate a message`}>
      {#if generating}<RefreshCw class="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />{:else}<Sparkles class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{/if}
      {generating ? "Generating…" : staged ? "Generate message" : "Stage all & generate"}
    </button>
    <button class="inline-flex min-h-8 items-center justify-center gap-1 rounded-md border border-border bg-panel-strong px-1.5 text-xs font-medium hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
      type="button" disabled={!canPrepare} onclick={() => onReview(undefined, reviewScope)}
      title={!gitAssistantReady ? "Connect to run code review" : staged ? `Review ${staged} staged files before committing` : "Review all changes, including untracked files. Does not stage or commit."}>
      {#if llmActionId?.startsWith("review:")}<RefreshCw class="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />{:else}<ShieldCheck class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{/if}
      {llmActionId?.startsWith("review:") ? "Reviewing…" : "Code review"}
    </button>
  </div>
  <div class="flex items-center justify-between gap-1 text-xs text-muted-foreground">
    <label for="git-commit-message" class="font-medium text-foreground">Commit message</label>
    <span>{staged} staged · review {reviewScope}</span>
  </div>
  <textarea id="git-commit-message" class="block min-h-16 max-h-40 w-full overflow-y-hidden rounded-md border border-input bg-panel-strong px-2 py-1.5 font-mono text-xs leading-4 text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
    bind:this={messageTextarea}
    aria-label="Commit message" placeholder="Describe what changed…" value={message} disabled={submitting || actionId === "commit"}
    oninput={(event) => edit(event.currentTarget.value)}
    onkeydown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void commit(!event.shiftKey && !pushBlocked); } }}
  ></textarea>
  {#if draftNotice}<p class="text-xs leading-4 text-tool-warning" role="status">{draftNotice}</p>{/if}
  <div class="flex gap-1.5">
    <button class={["inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border px-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40", pushBlocked ? "border-transparent bg-primary text-primary-foreground hover:brightness-110" : "border-border bg-panel-strong text-foreground hover:bg-panel-hover"]}
      type="button" disabled={!canCommit} title={`${commitHint}. Ctrl/Cmd+Shift+Enter`} onclick={() => void commit(false)}>
      <GitCommitHorizontal class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />Commit
    </button>
    <button class="inline-flex h-8 flex-[1.6] items-center justify-center gap-1.5 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
      type="button" disabled={!canCommit || Boolean(pushBlocked)} title={pushBlocked ?? `${commitHint}, then push. Ctrl/Cmd+Enter`} onclick={() => void commit(true)}>
      {#if submitting}<RefreshCw class="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />{:else}<Upload class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{/if}
      {submitting ? actionId === "push" ? "Pushing…" : "Committing…" : "Commit & push"}
    </button>
  </div>
  {#if !gitAssistantReady}<p class="text-xs leading-4 text-muted-foreground">AI actions need a ready connection. Manual Git actions remain available.</p>
  {:else if pushBlocked}<p class="text-xs leading-4 text-muted-foreground">{pushBlocked}. You can commit locally.</p>
  {:else if staged === 0}<p class="text-xs leading-4 text-muted-foreground">Choose files above, or explicitly stage all when generating.</p>{/if}
</section>
