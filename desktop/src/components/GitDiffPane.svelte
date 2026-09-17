<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import Copy from "@lucide/svelte/icons/copy";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import Wrench from "@lucide/svelte/icons/wrench";
  import { onDestroy } from "svelte";
  import { gitReviewHasFindings, type GitDiff } from "../lib/git";
  import type { ProjectFileLineRange } from "../lib/project-files";
  import MarkdownText from "./MarkdownText.svelte";

  let {
    diff,
    review,
    reviewStale = false,
    reviewLoading,
    resolveLoading,
    canReview,
    canResolve,
    onValidateProjectFile,
    onValidateLocalFile,
    onOpenProjectFile,
    onOpenLocalFile,
    onReview,
    onCopyPrompt,
    onResolve,
  }: {
    diff: GitDiff;
    review?: string;
    reviewStale?: boolean;
    reviewLoading: boolean;
    resolveLoading: boolean;
    canReview: boolean;
    canResolve: boolean;
    onValidateProjectFile?: (path: string) => Promise<boolean>;
    onValidateLocalFile?: (path: string) => Promise<boolean>;
    onOpenProjectFile?: (path: string, range?: ProjectFileLineRange) => void | Promise<void>;
    onOpenLocalFile?: (path: string) => void | Promise<void>;
    onReview: () => void;
    onCopyPrompt: () => boolean | Promise<boolean>;
    onResolve: () => void;
  } = $props();

  const title = $derived(diff.path ?? "All changes");
  const scopeLabel = $derived(diff.scope === "staged" ? "Staged" : diff.scope === "unstaged" ? "Working Tree" : "All Changes");
  const lines = $derived(diff.content.split("\n"));
  const hasReviewFindings = $derived(gitReviewHasFindings(review));
  const copyPromptDisabled = $derived(!canResolve || reviewLoading || resolveLoading || reviewStale);
  let view = $state<"review" | "diff">("diff");
  let observedDiff: GitDiff | undefined;
  let wasReviewLoading = false;
  $effect(() => {
    // Completion must not interrupt somebody inspecting Diff while review runs.
    if (diff !== observedDiff || (reviewLoading && !wasReviewLoading)) view = reviewLoading || review ? "review" : "diff";
    observedDiff = diff;
    wasReviewLoading = reviewLoading;
  });
  let copyPromptConfirmed = $state(false);
  let copyPromptResetTimer: ReturnType<typeof setTimeout> | undefined;

  async function copyPrompt(): Promise<void> {
    if (copyPromptDisabled) return;
    const copied = await onCopyPrompt();
    if (!copied) return;
    copyPromptConfirmed = true;
    if (copyPromptResetTimer) clearTimeout(copyPromptResetTimer);
    copyPromptResetTimer = setTimeout(() => {
      copyPromptConfirmed = false;
      copyPromptResetTimer = undefined;
    }, 1_600);
  }

  onDestroy(() => {
    if (copyPromptResetTimer) clearTimeout(copyPromptResetTimer);
  });

  function lineTone(line: string): string {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) return "text-muted-foreground";
    if (line.startsWith("+")) return "bg-tool-success/7 text-tool-success";
    if (line.startsWith("-")) return "bg-tool-error/7 text-tool-error";
    if (line.startsWith("@@")) return "bg-tool-info/6 text-tool-info";
    if (line.startsWith("diff --git") || line.startsWith("index ")) return "text-foreground font-semibold";
    return "text-foreground/80";
  }
</script>

<section
  class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
  aria-label={`Git diff ${title}`}
>
    <header class="flex min-h-9 min-w-0 flex-wrap items-center gap-2 border-b border-border bg-chrome px-3 py-1">
      <strong class="min-w-0 flex-1 truncate text-xs font-medium" title={title}>{title}</strong>
      <span class="rounded border border-border bg-muted px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{scopeLabel}</span>
      {#if review || reviewLoading}
        <div class="flex rounded-md border border-border p-0.5" role="group" aria-label="Git editor view">
          <button class={["h-6 rounded-sm px-2 text-xs focus-visible:outline-2 focus-visible:outline-ring", view === "review" ? "bg-panel-selected text-foreground" : "text-muted-foreground hover:bg-panel-hover"]} type="button" aria-pressed={view === "review"} onclick={() => view = "review"}>Review</button>
          <button class={["h-6 rounded-sm px-2 text-xs focus-visible:outline-2 focus-visible:outline-ring", view === "diff" ? "bg-panel-selected text-foreground" : "text-muted-foreground hover:bg-panel-hover"]} type="button" aria-pressed={view === "diff"} onclick={() => view = "diff"}>Diff</button>
        </div>
      {/if}
      <button
        class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-primary hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
        type="button"
        disabled={!canReview || reviewLoading || !diff.content.trim()}
        title={canReview ? "Review this diff with LLM" : "Open a ready session to use LLM review"}
        onclick={onReview}
      >
        {#if reviewLoading}<RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{:else}<Sparkles class="h-3.5 w-3.5" aria-hidden="true" />{/if}
        {reviewLoading ? "Reviewing…" : review ? "Run again" : "Code review"}
      </button>
    </header>

    {#if (review || reviewLoading) && view === "review"}
      <section class="flex min-h-0 flex-1 flex-col overflow-hidden bg-panel" aria-label="LLM review">
        {#if reviewLoading && !review}
          <div class="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground" role="status"><RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Reviewing changes… You can inspect the diff while the review runs.</div>
        {:else if review}
          {#if hasReviewFindings}
            <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
              <span class="mr-auto text-xs text-muted-foreground">Verify findings, then fix or commit.</span>
              <button
                class="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
                type="button"
                disabled={copyPromptDisabled}
                title={copyPromptConfirmed ? "Prompt copied to clipboard" : "Copy the exact prompt that Fix in new session would send"}
                onclick={copyPrompt}
                aria-live="polite"
              >
                {#if copyPromptConfirmed}<Check class="h-3.5 w-3.5" aria-hidden="true" />{:else}<Copy class="h-3.5 w-3.5" aria-hidden="true" />{/if}
                {copyPromptConfirmed ? "Copied" : "Copy prompt"}
              </button>
              <button
                class="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
                type="button"
                disabled={!canResolve || resolveLoading || reviewLoading || reviewStale}
                title={canResolve ? "Start a new Pix session to verify and resolve these findings" : "Source Control is busy"}
                onclick={onResolve}
              >
                {#if resolveLoading}<RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{:else}<Wrench class="h-3.5 w-3.5" aria-hidden="true" />{/if}
                {resolveLoading ? "Starting session…" : "Fix in new session"}
              </button>
            </div>
          {/if}
          {#if reviewStale}<p class="border-b border-tool-warning/25 bg-tool-warning/5 px-4 py-2 text-xs text-tool-warning" role="status">Changes have moved on since this review. Run it again before starting a fix session.</p>{/if}
          <div class="min-h-0 flex-1 overflow-auto px-4 py-3"><MarkdownText text={review} {onValidateProjectFile} {onValidateLocalFile} {onOpenProjectFile} {onOpenLocalFile} /></div>
        {/if}
      </section>
    {/if}

    {#if diff.truncated && view === "diff"}
      <div class="border-b border-tool-warning/20 bg-tool-warning/5 px-3 py-1.5 text-xs text-tool-warning">Diff preview was truncated to keep the UI responsive.</div>
    {/if}

    <div class={["min-h-0 flex-1 overflow-auto bg-code", view === "review" && (review || reviewLoading) ? "hidden" : ""]}>
      {#if diff.content.trim()}
        <pre class="min-w-max py-2 font-mono text-xs leading-4"><code>{#each lines as line, index (`${index}:${line}`)}<span class={["block min-h-4 whitespace-pre px-3", lineTone(line)]}>{line || " "}</span>{/each}</code></pre>
      {:else}
        <div class="grid h-full place-items-center text-xs text-muted-foreground">No diff for this selection.</div>
      {/if}
    </div>
</section>
