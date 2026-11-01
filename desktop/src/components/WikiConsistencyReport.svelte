<script lang="ts">
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import { getContext, untrack } from "svelte";
  import { WIKI_CONFLICTS_NAVIGATION_CONTEXT, type WikiConflictsNavigation } from "../app/workbench-wiki-conflicts.svelte";
  import type { KnowledgeCheckResult, KnowledgeCitation, KnowledgeReportLanguage } from "../../../acp/src/knowledge/contract";
  import type { ProjectFileLineRange } from "../lib/project-files";
  import { knowledgeCheckReportText } from "./wiki-consistency-report-text";
  import WikiConsistencyCitation from "./WikiConsistencyCitation.svelte";

  let {
    checking = false,
    queued = false,
    compact = false,
    collapsedByDefault = false,
    result,
    canSaveAnyway = false,
    canOpenSources = false,
    resolving = false,
    stale = false,
    checkedAt,
    onRetry,
    onCancel,
    onSaveAnyway,
    onOpenSource,
    onOpenCitation,
    onResolve,
  }: {
    checking?: boolean;
    queued?: boolean;
    compact?: boolean;
    collapsedByDefault?: boolean;
    result?: KnowledgeCheckResult;
    canSaveAnyway?: boolean;
    canOpenSources?: boolean;
    resolving?: boolean;
    stale?: boolean;
    checkedAt?: string;
    onRetry?: () => void;
    onCancel: () => void;
    onSaveAnyway: () => void;
    onOpenSource?: (path: string, range?: ProjectFileLineRange) => void | Promise<void>;
    onOpenCitation?: (citation: KnowledgeCitation, language?: KnowledgeReportLanguage) => void | Promise<void>;
    onResolve?: () => void | Promise<void>;
  } = $props();

  let expanded = $state(untrack(() => !collapsedByDefault));
  let sourcesExpanded = $state(false);
  const reportId = $props.id();
  // Absent outside the Desktop shell (isolated renders); the action is then hidden.
  const conflictsNavigation = getContext<WikiConflictsNavigation | undefined>(WIKI_CONFLICTS_NAVIGATION_CONTEXT);
  let observedResult: KnowledgeCheckResult | undefined;
  let observedCollapsedByDefault: boolean | undefined;
  const text = $derived(knowledgeCheckReportText(result, checking, queued, stale));
  const reportOpen = $derived(expanded && !!result && !checking);
  const singleLine = $derived(collapsedByDefault && !reportOpen);
  const uncertainties = $derived(result?.uncertainties ?? []);
  const sources = $derived(result?.reviewedSources ?? []);
  const actionClass = "min-w-0 max-w-full whitespace-normal break-words rounded-sm px-2 py-1 text-xs font-medium hover:bg-panel-hover disabled:opacity-40";
  const disclosureClass = "flex min-w-0 cursor-pointer list-none items-start gap-1.5 py-2 text-left [&::-webkit-details-marker]:hidden";

  $effect(() => {
    if (result === observedResult && collapsedByDefault === observedCollapsedByDefault) return;
    observedResult = result;
    observedCollapsedByDefault = collapsedByDefault;
    expanded = !collapsedByDefault;
    sourcesExpanded = false;
  });
</script>

<section class="min-h-0 shrink-0 border-b border-border bg-panel text-xs" aria-label={text.sectionLabel} aria-busy={checking} data-wiki-consistency-report>
  <div class={singleLine ? "flex min-w-0 items-center gap-1 px-3 py-1" : "flex min-w-0 flex-col items-start gap-1 px-3 py-2"}>
    <button
      type="button"
      class={["flex w-full min-w-0 gap-1.5 rounded-sm py-1 pr-2 text-left hover:bg-panel-hover", singleLine ? "items-center" : "items-start"]}
      aria-expanded={reportOpen}
      aria-controls={`${reportId}-body`}
      aria-label={reportOpen ? text.collapseReport : text.expandReport}
      disabled={checking || !result}
      onclick={() => expanded = !expanded}
    >
      <ChevronRight class={["mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", reportOpen ? "rotate-90" : ""]} aria-hidden="true" />
      <span class={singleLine ? "min-w-0 truncate" : "min-w-0 whitespace-normal break-words"} title={singleLine ? `${stale && !checking ? text.staleSummary : text.summary}${result && !checking ? ` · ${text.counts}` : ""}` : undefined}>
        <span class={[singleLine ? "font-medium" : "block font-medium", !checking && !stale && result?.status === "conflicts" ? "text-tool-error" : !checking && !stale && result?.status === "clear" ? "text-tool-success" : "text-tool-warning"]} role="status" aria-live="polite">{stale && !checking ? text.staleSummary : text.summary}</span>
        {#if result && !checking}<span class={[singleLine ? "" : "mt-1 block", "text-muted-foreground"]}>{singleLine ? " · " : ""}{text.counts}</span>{/if}
      </span>
    </button>
    <div hidden={singleLine && !checking} class={singleLine ? "shrink-0" : "flex w-full min-w-0 flex-wrap items-center gap-1"}>
      {#if checking}
        <button class={actionClass} type="button" onclick={onCancel}>{text.cancelCheck}</button>
      {:else}
        {#if result && result.status !== "clear" && /^[0-9a-f]{64}$/u.test(result.documentHash) && onResolve}
          <button class={[actionClass, "border border-border text-foreground"]} type="button" disabled={resolving || stale} title={stale ? text.resolveStale : undefined} aria-busy={resolving} onclick={() => void onResolve?.()}>{resolving ? text.resolving : text.resolveInSession}</button>
        {/if}
        {#if conflictsNavigation && result && (result.conflicts.length || result.uncertainties?.length)}
          <button class={actionClass} type="button" data-open-wiki-conflicts onclick={() => conflictsNavigation.open({ path: result.path })}>{result.reportLanguage === "ru" ? "Открыть в Wiki Conflicts" : "Open in Wiki Conflicts"}</button>
        {/if}
        {#if onRetry}<button class={actionClass} type="button" disabled={resolving} onclick={onRetry}>{text.checkAgain}</button>{/if}
        {#if canSaveAnyway}
          <button class={[actionClass, "text-tool-warning"]} type="button" disabled={resolving || stale} onclick={onSaveAnyway}>{text.saveAnyway}</button>
        {/if}
        <button class={actionClass} type="button" onclick={onCancel} aria-label={text.dismissResult}>{text.dismiss}</button>
      {/if}
    </div>
  </div>
  {#if result && !checking}
    {#key result}
    <div id={`${reportId}-body`} hidden={!expanded} class={["min-h-0 space-y-3 border-t border-border px-3 py-3", compact ? "" : "max-h-[min(65vh,44rem)] overflow-auto"]} data-wiki-report-body>
      <section aria-label={text.overviewLabel}>
        <h3 class="font-medium">{text.overviewLabel}</h3>
        {#if stale}<p class="mt-1 text-tool-warning">{text.staleReport}</p>{/if}
        {#if checkedAt}<p class="mt-1 text-muted-foreground">{text.savedReportLabel}: <time datetime={checkedAt}>{checkedAt}</time></p>{/if}
        <p class="mt-1 break-all text-muted-foreground">{text.documentLabel}: <span class="font-mono">{result.path}</span></p>
        <p class="mt-1 text-muted-foreground">{text.reviewed}</p>
        {#if text.chunkReview}<p class="mt-1 text-muted-foreground">{text.chunkReview}</p>{/if}
        {#if text.selection}<p class="mt-1 text-muted-foreground">{text.scopeLabel}: {text.selection}.</p>{/if}
        <p class="mt-1 break-words text-muted-foreground">{text.judgeLabel}: {result.modelRef || text.modelUnavailable}</p>
      </section>

      {#each [{ findings: result.conflicts, label: text.conflictsLabel, uncertainty: false }, { findings: uncertainties, label: text.uncertaintiesLabel, uncertainty: true }] as group}
        {#if group.findings.length}
          <section aria-label={group.label} class="border-t border-border pt-3">
            <h3 class="font-medium">{group.label} · {group.findings.length}</h3>
            {#if group.uncertainty}<p class="mt-1 text-muted-foreground">{text.uncertaintyHelp}</p>{/if}
            <ol class="mt-1 divide-y divide-border">
              {#each group.findings as finding, index}
                <li>
                  <details class="group" open={index === 0}>
                    <summary class={disclosureClass}>
                      <ChevronRight class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
                      <span class="min-w-0 line-clamp-3 whitespace-pre-wrap break-words font-medium group-open:line-clamp-none">{index + 1}. {finding.explanation}</span>
                    </summary>
                    <div class={["grid gap-3 pb-3 pl-5", compact ? "" : "lg:grid-cols-2"]}>
                      <WikiConsistencyCitation citation={finding.draft} label={text.draftLabel} language={result.reportLanguage} canOpen={canOpenSources} openLabel={text.openSource} blockedLabel={text.openSourceBlocked} {onOpenCitation} {onOpenSource} />
                      <WikiConsistencyCitation citation={finding.existing} label={finding.existing.path === result.path ? text.sameDocumentLabel : text.sourceLabel} language={result.reportLanguage} canOpen={canOpenSources} openLabel={text.openSource} blockedLabel={text.openSourceBlocked} {onOpenCitation} {onOpenSource} />
                    </div>
                  </details>
                </li>
              {/each}
            </ol>
          </section>
        {/if}
      {/each}

      {#if result.notices.length}
        <details class="group border-t border-border" open={!result.conflicts.length && !uncertainties.length}>
          <summary class={[disclosureClass, "font-medium"]}>
            <ChevronRight class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
            <span>{text.noticesLabel} · {result.notices.length}</span>
          </summary>
          <ul class="list-disc space-y-1 pb-2 pl-5 leading-relaxed text-muted-foreground">{#each result.notices as notice}<li class="whitespace-pre-wrap break-words">{notice}</li>{/each}</ul>
        </details>
      {/if}

      <section class="border-t border-border" aria-label={text.sourcesLabel}>
        <button type="button" class="flex w-full items-start gap-1.5 rounded-sm py-2 text-left font-medium hover:bg-panel-hover" aria-expanded={sourcesExpanded} aria-controls={`${reportId}-sources`} onclick={() => sourcesExpanded = !sourcesExpanded}>
          <ChevronRight class={["h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", sourcesExpanded ? "rotate-90" : ""]} aria-hidden="true" />
          <span>{text.sourcesLabel}{result.reviewedSources ? ` · ${sources.length}` : ""}</span>
        </button>
        <div id={`${reportId}-sources`} hidden={!sourcesExpanded}>
          {#if text.retainedEvidence}<p class="pb-2 text-muted-foreground">{text.retainedEvidence}</p>{/if}
          {#if result.reviewedSources === undefined}
            <p class="pb-2 text-muted-foreground">{text.sourcesUnavailable}</p>
          {:else if !sources.length}
            <p class="pb-2 text-muted-foreground">{text.noSources}</p>
          {:else}
            <p class="pb-2 text-muted-foreground">{text.sourceSnapshots}</p>
            <ol class="divide-y divide-border">
              {#each sources as source}
                <li>
                  <details class="group">
                    <summary class={disclosureClass}>
                      <ChevronRight class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
                      <span class="min-w-0 break-all font-mono text-muted-foreground">{source.path}:L{source.startLine}{source.endLine === source.startLine ? "" : `–${source.endLine}`}</span>
                    </summary>
                    <div class="pb-3 pl-5"><WikiConsistencyCitation citation={source} language={result.reportLanguage} canOpen={canOpenSources} openLabel={text.openSource} blockedLabel={text.openSourceBlocked} {onOpenCitation} {onOpenSource} /></div>
                  </details>
                </li>
              {/each}
            </ol>
          {/if}
        </div>
      </section>
    </div>
    {/key}
  {/if}
</section>
