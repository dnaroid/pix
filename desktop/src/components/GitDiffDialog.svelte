<script lang="ts">
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import Wrench from "@lucide/svelte/icons/wrench";
  import X from "@lucide/svelte/icons/x";
  import { gitReviewHasFindings, type GitDiff } from "../lib/git";
  import type { ProjectFileLineRange } from "../lib/project-files";
  import MarkdownText from "./MarkdownText.svelte";

  let {
    diff,
    review,
    reviewLoading,
    resolveLoading,
    canReview,
    canResolve,
    onValidateProjectFile,
    onValidateLocalFile,
    onOpenProjectFile,
    onOpenLocalFile,
    onReview,
    onResolve,
    onClose,
  }: {
    diff: GitDiff;
    review?: string;
    reviewLoading: boolean;
    resolveLoading: boolean;
    canReview: boolean;
    canResolve: boolean;
    onValidateProjectFile?: (path: string) => Promise<boolean>;
    onValidateLocalFile?: (path: string) => Promise<boolean>;
    onOpenProjectFile?: (path: string, range?: ProjectFileLineRange) => void | Promise<void>;
    onOpenLocalFile?: (path: string) => void | Promise<void>;
    onReview: () => void;
    onResolve: () => void;
    onClose: () => void;
  } = $props();

  let dialogElement: HTMLDialogElement | undefined;
  let closeButton: HTMLButtonElement | undefined;

  const title = $derived(diff.path ?? "All changes");
  const scopeLabel = $derived(diff.scope === "staged" ? "Staged" : diff.scope === "unstaged" ? "Working Tree" : "All Changes");
  const lines = $derived(diff.content.split("\n"));
  const hasReviewFindings = $derived(gitReviewHasFindings(review));

  $effect(() => {
    const dialog = dialogElement;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.showModal();
    const frame = requestAnimationFrame(() => closeButton?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (dialog.open) dialog.close();
      requestAnimationFrame(() => previous?.focus());
    };
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

<dialog
  bind:this={dialogElement}
  class="fixed inset-0 z-40 m-auto h-screen max-h-none w-screen max-w-none place-items-center bg-transparent p-6 text-foreground backdrop:bg-overlay open:grid"
  aria-label={`Git diff ${title}`}
  oncancel={(event) => { event.preventDefault(); onClose(); }}
  onclick={(event) => { if (event.target === event.currentTarget) onClose(); }}
>
  <div class="flex h-[760px] max-h-[calc(100vh-48px)] min-h-[320px] w-[1120px] max-w-[calc(100vw-48px)] min-w-[480px] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md">
    <header class="flex min-h-10 min-w-0 items-center gap-2 border-b border-border px-3">
      <strong class="min-w-0 flex-1 truncate text-xs font-medium" title={title}>{title}</strong>
      <span class="rounded border border-border bg-muted px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{scopeLabel}</span>
      <button
        class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-primary hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
        type="button"
        disabled={!canReview || reviewLoading || !diff.content.trim()}
        title={canReview ? "Review this diff with LLM" : "Open a ready session to use LLM review"}
        onclick={onReview}
      >
        {#if reviewLoading}<RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{:else}<Sparkles class="h-3.5 w-3.5" aria-hidden="true" />{/if}
        {reviewLoading ? "Reviewing…" : "LLM Review"}
      </button>
      <button bind:this={closeButton} class="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" type="button" title="Close" aria-label="Close Git diff" onclick={onClose}><X class="h-4 w-4" aria-hidden="true" /></button>
    </header>

    {#if review || reviewLoading}
      <section class="max-h-[38%] overflow-auto border-b border-border bg-panel px-4 py-3" aria-label="LLM review">
        {#if reviewLoading && !review}
          <div class="flex items-center gap-2 text-[11px] text-muted-foreground"><RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Reviewing changes…</div>
        {:else if review}
          {#if hasReviewFindings}
            <div class="mb-2 flex justify-end">
              <button
                class="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[11px] font-medium text-primary-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
                type="button"
                disabled={!canResolve || resolveLoading}
                title={canResolve ? "Start a new Pix session to verify and resolve these findings" : "Source Control is busy"}
                onclick={onResolve}
              >
                {#if resolveLoading}<RefreshCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{:else}<Wrench class="h-3.5 w-3.5" aria-hidden="true" />{/if}
                {resolveLoading ? "Starting session…" : "Resolve in new session"}
              </button>
            </div>
          {/if}
          <MarkdownText text={review} {onValidateProjectFile} {onValidateLocalFile} {onOpenProjectFile} {onOpenLocalFile} />
        {/if}
      </section>
    {/if}

    {#if diff.truncated}
      <div class="border-b border-tool-warning/20 bg-tool-warning/5 px-3 py-1.5 text-[11px] text-tool-warning">Diff preview was truncated to keep the UI responsive.</div>
    {/if}

    <div class="min-h-0 flex-1 overflow-auto bg-code">
      {#if diff.content.trim()}
        <pre class="min-w-max py-2 font-mono text-[11px] leading-4"><code>{#each lines as line, index (`${index}:${line}`)}<span class={["block min-h-4 whitespace-pre px-3", lineTone(line)]}>{line || " "}</span>{/each}</code></pre>
      {:else}
        <div class="grid h-full place-items-center text-[11px] text-muted-foreground">No diff for this selection.</div>
      {/if}
    </div>
  </div>
</dialog>
