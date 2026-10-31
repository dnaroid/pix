<script lang="ts">
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import CircleQuestionMark from "@lucide/svelte/icons/circle-question-mark";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Bot from "@lucide/svelte/icons/bot";
  import Pencil from "@lucide/svelte/icons/pencil";
  import ShoppingBasket from "@lucide/svelte/icons/shopping-basket";
  import type { KnowledgeCitation, KnowledgeReportLanguage } from "../../../acp/src/knowledge/contract";
  import type { WikiCompareSide } from "../app/wiki-conflict-compare.svelte";
  import { knowledgeEvidenceText } from "../lib/knowledge-citation";
  import type { WikiFinding } from "../lib/wiki-conflicts-index";
  import { wikiColumnVerdict, wikiVerdictLabel, type WikiConflictsText } from "./wiki-conflicts-text";
  import MarkdownText from "./MarkdownText.svelte";
  import WikiConflictDecisionBar from "./WikiConflictDecisionBar.svelte";
  import type { WikiFindingDecisionInput } from "../app/wiki-finding-decision";
  import type { WikiSideEditRequest } from "../app/wiki-side-edit";
  import type { WikiEditableBlock } from "../lib/wiki-side-edit";
  import { tick } from "svelte";
  import type { ProjectFileLineRange } from "../lib/project-files";
  import { formatWikiDate, newerWikiSide, wikiQuoteTime, type WikiFileDates } from "../lib/wiki-file-dates";

  let { finding, draft, existing, draftDates = null, existingDates = null, text, rechecking = false, onRecheck, resolving = false, onResolve, inBasket = false, basketFull = false, onToggleBasket, deciding = false, retryDecision, onDecide, onCreateTask, onOpenTask, onEditSide, onOpenCitation, onOpenProjectFile, onValidateProjectFile }: {
    finding: WikiFinding;
    draft: WikiCompareSide;
    existing: WikiCompareSide;
    /** Git/file timestamps per side; null while unknown. */
    draftDates?: WikiFileDates | null;
    existingDates?: WikiFileDates | null;
    text: WikiConflictsText;
    rechecking?: boolean;
    onRecheck?: () => void | Promise<void>;
    resolving?: boolean;
    /** Starts a resolution session scoped to this finding; absent for stale findings or when unavailable. */
    onResolve?: () => void | Promise<void>;
    inBasket?: boolean;
    basketFull?: boolean;
    /** Adds or removes this finding from the batch-resolution basket. */
    onToggleBasket?: () => void;
    deciding?: boolean;
    /** Last attempted operation for this finding (null = clear); undefined when unknown. */
    retryDecision?: WikiFindingDecisionInput | null;
    /** Records or clears the user's verdict; absent when decisions cannot be written. */
    onDecide?: (decision: WikiFindingDecisionInput | null) => void | Promise<void>;
    onCreateTask?: () => void | Promise<void>;
    onOpenTask?: (taskId: string) => void | Promise<void>;
    /** Saves an inline edit of one side; resolves true when the file holds the edit. */
    onEditSide?: (request: WikiSideEditRequest) => Promise<boolean>;
    onOpenCitation?: (citation: KnowledgeCitation, language?: KnowledgeReportLanguage) => void | Promise<void>;
    /** Links inside rendered fragments open in Preview. */
    onOpenProjectFile?: (path: string, range?: ProjectFileLineRange) => void | Promise<void>;
    onValidateProjectFile?: (path: string) => Promise<boolean | "directory">;
  } = $props();

  type TableRows = { readonly first: number; readonly last: number } | undefined;
  /** Marks only the quoted rows of a partially quoted table; the header is row 0. */
  function highlightTableRows(node: HTMLElement, rows: TableRows) {
    let current = rows;
    let disposed = false;
    const apply = () => {
      if (disposed) return;
      node.querySelectorAll("tr").forEach((row, index) => {
        if (current && index >= current.first && index <= current.last) row.setAttribute("data-quoted-row", "");
        else row.removeAttribute("data-quoted-row");
      });
    };
    // The rendered table is a child's {@html}; wait for it to be committed.
    void tick().then(apply);
    return {
      update(next: TableRows) { current = next; void tick().then(apply); },
      destroy() { disposed = true; },
    };
  }

  // Column buttons go through the bar so the optional rationale is attached.
  let decisionBar = $state<ReturnType<typeof WikiConflictDecisionBar>>();
  const changed = (side: WikiCompareSide) => side.state === "ready" && side.context.status !== "matched";
  const textChanged = $derived(changed(draft) || changed(existing));
  const sides = $derived([
    { citation: finding.draft, side: draft, dates: draftDates, label: text.draftLabel },
    { citation: finding.existing, side: existing, dates: existingDates, label: finding.internal ? text.sameDocumentLabel : text.sourceLabel },
  ]);
  const newer = $derived(newerWikiSide([draftDates, existingDates]));
  const when = (time: number) => formatWikiDate(time, finding.reportLanguage);
  const iso = (time: number) => new Date(time).toISOString();

  // Inline edit of one side. The block captured at start is the CAS baseline.
  let editing = $state<{ index: number; path: string; block: WikiEditableBlock } | null>(null);
  let editText = $state("");
  let savingEdit = $state(false);
  let editInput = $state<HTMLTextAreaElement>();
  $effect(() => {
    void finding.id;
    editing = null;
    editText = "";
  });
  async function startEdit(index: number, path: string, block: WikiEditableBlock): Promise<void> {
    editing = { index, path, block };
    editText = block.text;
    await tick();
    editInput?.focus();
  }
  async function saveEdit(): Promise<void> {
    const target = editing;
    if (!target || !onEditSide || savingEdit) return;
    savingEdit = true;
    try {
      if (await onEditSide({ path: target.path, block: target.block, text: editText }) && editing === target) editing = null;
    } finally {
      savingEdit = false;
    }
  }
  const editRows = (value: string) => Math.min(24, Math.max(3, value.split("\n").length + 1));
  const location = (citation: KnowledgeCitation) =>
    `${citation.path}:L${citation.startLine}${citation.endLine === citation.startLine ? "" : `–${citation.endLine}`}`;
  const actionClass = "inline-flex min-w-0 items-center gap-1.5 rounded-sm border border-border px-2 py-1 text-xs font-medium hover:bg-panel-hover disabled:opacity-40";
</script>

<article class="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={finding.kind === "conflict" ? text.conflict : text.uncertainty} data-wiki-conflict-compare>
  <header class="shrink-0 space-y-2 border-b border-border px-4 py-3 text-xs">
    <div class="flex min-w-0 flex-wrap items-center gap-2">
      {#if finding.kind === "conflict"}
        <TriangleAlert class={["h-4 w-4 shrink-0", finding.stale ? "text-muted-foreground" : "text-tool-error"]} aria-hidden="true" />
      {:else}
        <CircleQuestionMark class={["h-4 w-4 shrink-0", finding.stale ? "text-muted-foreground" : "text-tool-warning"]} aria-hidden="true" />
      {/if}
      <h2 class="text-sm font-semibold">{finding.kind === "conflict" ? text.conflict : text.uncertainty}{finding.internal ? ` · ${text.internal}` : ""}</h2>
      {#if finding.stale}
        <span class="rounded-sm border border-border px-1.5 py-0.5 text-muted-foreground" title={text.staleHelp}>{text.stale}</span>
      {/if}
      <span class="flex-1"></span>
      {#if onResolve && !finding.stale}
        <button type="button" class={actionClass} disabled={resolving} aria-busy={resolving} title={text.resolveHelp} onclick={() => void onResolve?.()} data-wiki-resolve-finding>
          <Bot class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {resolving ? text.resolving : text.resolve}
        </button>
      {/if}
      {#if onToggleBasket && !finding.stale}
        <button type="button" class={actionClass} disabled={!inBasket && basketFull} aria-pressed={inBasket}
          title={!inBasket && basketFull ? text.basketFull : text.basketToggleHelp} onclick={() => onToggleBasket?.()} data-wiki-basket-toggle-compare>
          <ShoppingBasket class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {inBasket ? text.basketRemove : text.basketAdd}
        </button>
      {/if}
      {#if onRecheck}
        <button type="button" class={actionClass} disabled={rechecking} aria-busy={rechecking} title={text.recheckHelp} onclick={() => void onRecheck?.()}>
          <RefreshCw class={["h-3.5 w-3.5 shrink-0", rechecking ? "animate-spin motion-reduce:animate-none" : ""]} aria-hidden="true" />
          {rechecking ? text.rechecking : text.recheck}
        </button>
      {/if}
    </div>
    <p class="whitespace-pre-wrap break-words leading-relaxed">{finding.explanation}</p>
    <p class="break-words text-muted-foreground">
      {text.checkedAt}: <time datetime={finding.checkedAt}>{finding.checkedAt}</time>
      · {text.model}: {finding.modelRef || "—"}
      · {text.reports}: <span class="font-mono">{finding.reportPaths.join(", ")}</span>
    </p>
  </header>

  {#if onDecide}
    <WikiConflictDecisionBar bind:this={decisionBar} {finding} {text} {deciding} sidesInColumns {retryDecision} {onDecide} {onCreateTask} {onOpenTask} />
  {/if}

  {#if finding.stale}
    <p class="shrink-0 border-b border-border px-4 py-2 text-xs text-muted-foreground" role="note">{text.staleHelp}</p>
  {/if}
  {#if textChanged}
    <div class="shrink-0 border-b border-border px-4 py-2 text-xs text-tool-warning" role="status" data-wiki-text-changed>
      <span class="font-medium">{text.textChanged}.</span> {text.textChangedHelp}
    </div>
  {/if}

  <div class="grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-2">
    {#each sides as { citation, side, dates, label }, index (index)}
      <section class={["min-w-0 px-4 py-3 text-xs", index === 1 ? "border-t border-border lg:border-t-0 lg:border-l" : ""]} aria-label={label}>
        <p class="flex flex-wrap items-center gap-2 font-medium text-muted-foreground">
          {label}
          {#if newer === index}
            <span class="rounded-sm border border-border px-1.5 py-0.5 font-normal text-foreground" title={text.newerSideHelp} data-wiki-newer-side>{text.newerSide}</span>
          {/if}
          {#if onDecide}
            {@const verdict = wikiColumnVerdict(finding, index === 0 ? 0 : 1)}
            {@const active = finding.decision?.verdict === verdict}
            <button type="button"
              class={["ml-auto inline-flex min-w-0 items-center gap-1.5 rounded-sm border px-2 py-1 text-xs font-normal text-foreground hover:bg-panel-hover disabled:opacity-40",
                active ? "border-foreground/40 bg-panel-hover font-medium" : "border-border"]}
              disabled={deciding} aria-pressed={active} aria-keyshortcuts={String(index + 1)} title={text.verdictHelp.side}
              onclick={() => void decisionBar?.choose(verdict)} data-wiki-verdict={verdict} data-wiki-column-verdict={index}>
              <kbd class="font-mono text-xs text-muted-foreground">{index + 1}</kbd>
              <span class="truncate">{wikiVerdictLabel(text, finding, verdict)}</span>
            </button>
          {/if}
        </p>
        <button type="button"
          class="mt-1 max-w-full break-all text-left font-mono text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground disabled:cursor-default disabled:no-underline"
          disabled={!onOpenCitation}
          aria-label={`${text.openSource}: ${location(citation)}`}
          title={text.openSource}
          onclick={() => void onOpenCitation?.(citation, finding.reportLanguage)}>{location(citation)}</button>
        {#if onEditSide && !finding.stale && side.state === "ready" && side.block && editing?.index !== index}
          {@const block = side.block}
          <button type="button" class={["ml-2", actionClass]} disabled={savingEdit || editing !== null} title={text.editSideHelp}
            onclick={() => void startEdit(index, citation.path, block)} data-wiki-edit-side>
            <Pencil class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{text.editSide}
          </button>
        {/if}
        {#if dates}
          {@const quoteTime = wikiQuoteTime(dates)}
          <p class="mt-1 break-words text-muted-foreground" data-wiki-side-dates>
            {#if dates.tracked}
              {#if dates.createdAt != null}{text.createdAt}: <time datetime={iso(dates.createdAt)}>{when(dates.createdAt)}</time>{/if}
              {#if dates.committedAt != null} · {text.changedAt}: <time datetime={iso(dates.committedAt)}>{when(dates.committedAt)}</time>{/if}
            {:else if dates.modifiedAt != null}
              {text.fileModifiedAt}: <time datetime={iso(dates.modifiedAt)}>{when(dates.modifiedAt)}</time>
            {/if}
            {#if quoteTime != null && (dates.linesCommittedAt != null || dates.linesUncommitted)}
              · {text.quoteChangedAt}: <time class="font-medium text-foreground" datetime={iso(quoteTime)}>{when(quoteTime)}</time>
            {/if}
            {#if dates.uncommitted}
              · <span class="text-tool-warning" title={text.notCommittedHelp}>{text.notCommitted}</span>
            {/if}
          </p>
        {/if}
        {#if side.state === "loading" || side.state === "idle"}
          <p class="mt-2 text-muted-foreground" role="status">{text.loading}</p>
        {:else if side.state === "error"}
          <p class="mt-2 break-words text-tool-error" role="alert">{text.readFailed}: {side.message}</p>
        {:else if editing?.index === index}
          <form class="mt-2 space-y-2" onsubmit={(event) => { event.preventDefault(); void saveEdit(); }} data-wiki-side-editor>
            <label class="sr-only" for={`wiki-side-edit-${index}`}>{text.editLabel}</label>
            <textarea id={`wiki-side-edit-${index}`} bind:this={editInput} bind:value={editText} rows={editRows(editText)}
              class="block w-full resize-y rounded-sm border border-border bg-background px-2 py-1 font-mono text-xs leading-relaxed"
              spellcheck="false" disabled={savingEdit}
              onkeydown={(event) => {
                if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); editing = null; }
                else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void saveEdit(); }
              }}></textarea>
            <div class="flex flex-wrap items-center gap-2">
              <button type="submit" class={actionClass} disabled={savingEdit || editText === editing.block.text} aria-busy={savingEdit}>
                {savingEdit ? text.savingEdit : text.saveEdit}
              </button>
              <button type="button" class="rounded-sm px-2 py-1 hover:bg-panel-hover disabled:opacity-40" disabled={savingEdit}
                onclick={() => editing = null}>{text.cancel}</button>
              <span class="text-muted-foreground">{text.editHint}</span>
            </div>
          </form>
        {:else if side.context.status === "matched"}
          {#if side.context.heading}
            <p class="mt-2 break-words text-muted-foreground">{text.sectionLabel}: <span class="font-medium text-foreground">{side.context.heading}</span></p>
          {/if}
          <div class="mt-2 min-w-0 space-y-2 rounded-sm border border-border bg-background px-3 py-2" data-wiki-citation-context>
            {#if side.context.before}
              <div class="opacity-60"><MarkdownText text={side.context.before} dense fitTables documentPath={citation.path} {onOpenProjectFile} {onValidateProjectFile} /></div>
            {/if}
            <div class={["wiki-quote -mx-3 px-3 py-1", side.context.tableRows ? "" : "border-l-2 border-tool-warning bg-panel-hover"]} data-highlighted
              title={`L${side.context.startLine}${side.context.endLine === side.context.startLine ? "" : `–${side.context.endLine}`}`}
              use:highlightTableRows={side.context.tableRows}>
              <MarkdownText text={side.context.quote} dense fitTables documentPath={citation.path} {onOpenProjectFile} {onValidateProjectFile} />
            </div>
            {#if side.context.after}
              <div class="opacity-60"><MarkdownText text={side.context.after} dense fitTables documentPath={citation.path} {onOpenProjectFile} {onValidateProjectFile} /></div>
            {/if}
          </div>
          {#if side.context.truncated}<p class="mt-1 text-muted-foreground">{text.contextTruncated}</p>{/if}
        {:else}
          <p class="mt-2 text-tool-warning">{knowledgeEvidenceText(side.context.status, finding.reportLanguage)}</p>
          <p class="mt-2 font-medium text-muted-foreground">{text.savedQuote}</p>
          <blockquote class="mt-1 whitespace-pre-wrap break-words border-l-2 border-border pl-2 leading-relaxed">{citation.quote}</blockquote>
        {/if}
      </section>
    {/each}
  </div>
</article>

<style>
  .wiki-quote :global(tr[data-quoted-row] > *) {
    background: var(--color-panel-hover);
    color: var(--color-foreground);
  }
  .wiki-quote :global(tr[data-quoted-row] > :first-child) {
    box-shadow: inset 2px 0 0 var(--color-tool-warning);
  }
</style>
