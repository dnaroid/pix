<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import ChevronUp from "@lucide/svelte/icons/chevron-up";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ListTree from "@lucide/svelte/icons/list-tree";
  import Bot from "@lucide/svelte/icons/bot";
  import ShoppingBasket from "@lucide/svelte/icons/shopping-basket";
  import type { KnowledgeCitation, KnowledgeReportLanguage } from "../../../acp/src/knowledge/contract";
  import { createWikiConflictCompare } from "../app/wiki-conflict-compare.svelte";
  import type { WikiConflictsInbox } from "../app/wiki-conflicts-inbox.svelte";
  import type { WikiFinding } from "../lib/wiki-conflicts-index";
  import type { ProjectFileLineRange } from "../lib/project-files";
  import WikiConflictCompare from "./WikiConflictCompare.svelte";
  import type { WikiFindingDecisionInput } from "../app/wiki-finding-decision";
  import type { WikiSideEditRequest } from "../app/wiki-side-edit";
  import type { WikiFileDates, WikiFileDatesRequest } from "../lib/wiki-file-dates";

  /** Comparison-only tab; the findings list lives in the Wiki sidebar panel. */
  let { inbox, read, reportError, dates, rechecking, onRecheck, resolving = false, onResolve, onResolveBasket, onDecide, onCreateTask, onOpenTask, onEditSide, onOpenCitation, onOpenProjectFile, onValidateProjectFile, onShowList }: {
    inbox: WikiConflictsInbox;
    read: (path: string, signal: AbortSignal) => Promise<string>;
    reportError: (error: unknown) => void;
    /** Optional Git/file timestamps of a comparison side; resolves null on failure. */
    dates?: (request: WikiFileDatesRequest, signal: AbortSignal) => Promise<WikiFileDates | null>;
    rechecking?: (finding: WikiFinding) => boolean;
    onRecheck?: (finding: WikiFinding) => void | Promise<unknown>;
    resolving?: boolean;
    onResolve?: (finding: WikiFinding) => void | Promise<unknown>;
    /** One session for all basket findings; resolves the handed-off ids, or null when nothing started. */
    onResolveBasket?: (findings: readonly WikiFinding[]) => Promise<{ readonly sent: readonly string[]; readonly skipped: readonly string[] } | null>;
    /** Writes the verdict into every report containing the finding. */
    onDecide?: (finding: WikiFinding, decision: WikiFindingDecisionInput | null) => Promise<unknown>;
    /** Creates a project task for a deferred finding and links it in the decision. */
    onCreateTask?: (finding: WikiFinding) => Promise<unknown>;
    onOpenTask?: (taskId: string) => void | Promise<void>;
    /** Saves an inline edit of one comparison side; true when written. */
    onEditSide?: (finding: WikiFinding, request: WikiSideEditRequest) => Promise<boolean>;
    onOpenCitation?: (citation: KnowledgeCitation, language?: KnowledgeReportLanguage) => void | Promise<void>;
    onOpenProjectFile?: (path: string, range?: ProjectFileLineRange) => void | Promise<void>;
    onValidateProjectFile?: (path: string) => Promise<boolean | "directory">;
    onShowList?: () => void;
  } = $props();

  const text = $derived(inbox.text);
  const activeFinding = $derived(inbox.activeFinding);
  const total = $derived(inbox.rows.length);
  const index = $derived(inbox.activeIndex);

  const compare = createWikiConflictCompare({
    read: (path, signal) => read(path, signal),
    reportError: error => reportError(error),
    dates: (request, signal) => dates ? dates(request, signal) : Promise.resolve(null),
  });
  $effect(() => {
    const finding = activeFinding;
    untrack(() => compare.select(finding));
  });
  onDestroy(compare.dispose);

  // One decision write at a time; the finding identity owns the pending state.
  let decidingId = $state<string | null>(null);
  // Retry after a partial write repeats the attempted operation, not the surviving verdict.
  let lastAttempt = $state<{ findingId: string; decision: WikiFindingDecisionInput | null } | null>(null);
  async function decide(finding: WikiFinding, decision: WikiFindingDecisionInput | null): Promise<void> {
    if (!onDecide || decidingId) return;
    decidingId = finding.id;
    lastAttempt = { findingId: finding.id, decision };
    try { await onDecide(finding, decision); } finally { decidingId = null; }
  }
  // Task creation writes the decision too, so it shares the decision lock.
  async function createTask(finding: WikiFinding): Promise<void> {
    if (!onCreateTask || decidingId) return;
    decidingId = finding.id;
    try { await onCreateTask(finding); } finally { decidingId = null; }
  }

  let basketNotice = $state("");
  async function resolveBasket(): Promise<void> {
    if (!onResolveBasket || resolving || !inbox.basket.length) return;
    basketNotice = "";
    const outcome = await onResolveBasket(inbox.basket);
    if (!outcome) return;
    inbox.clearBasket(outcome.sent);
    if (outcome.skipped.length) basketNotice = text.basketSkipped(outcome.skipped.length);
  }

  const iconButton = "inline-flex h-6 w-6 items-center justify-center rounded-sm hover:bg-panel-hover disabled:opacity-40";
</script>

<section class="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label={text.heading} data-wiki-conflicts-tab>
  <div class="flex min-h-9 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-panel px-3 py-1 text-xs">
    <h1 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{text.heading}</h1>
    {#if inbox.snapshot}<span class="min-w-0 truncate text-muted-foreground" role="status">{text.summary(inbox.summary)}</span>{/if}
    <span class="flex-1"></span>
    {#if total}
      <span class="tabular-nums text-muted-foreground" data-wiki-conflicts-position>{text.position(index + 1, total)}</span>
      <button type="button" class={iconButton} aria-label={text.previous} title={text.previous} disabled={index <= 0} onclick={() => inbox.move(-1)}>
        <ChevronUp class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button type="button" class={iconButton} aria-label={text.next} title={text.next} disabled={index >= total - 1} onclick={() => inbox.move(1)}>
        <ChevronDown class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    {/if}
    {#if onShowList}
      <button type="button" class="inline-flex items-center gap-1.5 rounded-sm px-2 py-1 hover:bg-panel-hover" onclick={onShowList} data-wiki-conflicts-show-list>
        <ListTree class="h-3.5 w-3.5" aria-hidden="true" />{text.showList}
      </button>
    {/if}
  </div>

  {#if inbox.basket.length || basketNotice}
    <div class="flex min-h-9 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-panel px-3 py-1 text-xs" data-wiki-basket-bar>
      {#if inbox.basket.length}
        <ShoppingBasket class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span class="font-medium" role="status">{text.basketSummary(inbox.basket.length, inbox.basketPages)}</span>
      {/if}
      {#if basketNotice}<span class="text-muted-foreground" role="status" data-wiki-basket-notice>{basketNotice}</span>{/if}
      <span class="flex-1"></span>
      {#if inbox.basket.length && onResolveBasket}
        <button type="button" class="inline-flex items-center gap-1.5 rounded-sm bg-primary px-2 py-1 font-medium text-primary-foreground disabled:opacity-40"
          disabled={resolving} aria-busy={resolving} title={text.basketResolveHelp} onclick={() => void resolveBasket()} data-wiki-basket-resolve>
          <Bot class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{resolving ? text.resolving : text.basketResolve}
        </button>
      {/if}
      {#if inbox.basket.length}
        <button type="button" class="rounded-sm px-2 py-1 text-muted-foreground hover:bg-panel-hover" onclick={() => { inbox.clearBasket(); basketNotice = ""; }} data-wiki-basket-clear>{text.basketClear}</button>
      {/if}
    </div>
  {/if}

  {#if !inbox.snapshot}
    <p class="px-4 py-6 text-xs text-muted-foreground">{text.noWiki}</p>
  {:else if !inbox.findings.length}
    <div class="space-y-2 px-4 py-6 text-xs text-muted-foreground" data-wiki-conflicts-empty>
      {#if inbox.snapshot.complete}
        <p class="font-medium text-foreground">{text.emptyComplete}</p>
        <p>{text.emptyCoverage}</p>
      {:else}
        <p role="status">{text.scanning}</p>
      {/if}
    </div>
  {:else if activeFinding}
    <WikiConflictCompare
      finding={activeFinding}
      draft={compare.draft}
      existing={compare.existing}
      draftDates={compare.draftDates}
      existingDates={compare.existingDates}
      {text}
      rechecking={rechecking?.(activeFinding) ?? false}
      onRecheck={onRecheck ? () => void onRecheck?.(activeFinding) : undefined}
      {resolving}
      onResolve={onResolve ? () => void onResolve?.(activeFinding) : undefined}
      inBasket={inbox.inBasket(activeFinding)}
      basketFull={inbox.basketFull}
      onToggleBasket={onResolveBasket ? () => inbox.toggleBasket(activeFinding) : undefined}
      deciding={decidingId !== null}
      retryDecision={lastAttempt?.findingId === activeFinding.id ? lastAttempt.decision : undefined}
      onDecide={onDecide ? (decision) => decide(activeFinding, decision) : undefined}
      onCreateTask={onCreateTask ? () => createTask(activeFinding) : undefined}
      {onOpenTask}
      onEditSide={onEditSide ? async (request) => {
        const saved = await onEditSide(activeFinding, request);
        if (saved) compare.reload();
        return saved;
      } : undefined}
      {onOpenCitation}
      {onOpenProjectFile}
      {onValidateProjectFile}
    />
  {:else}
    <p class="flex-1 px-4 py-6 text-xs text-muted-foreground">{total ? text.selectFinding : text.emptyFiltered}</p>
  {/if}
</section>
