<script lang="ts">
  import { tick } from "svelte";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import CircleQuestionMark from "@lucide/svelte/icons/circle-question-mark";
  import X from "@lucide/svelte/icons/x";
  import Clock from "@lucide/svelte/icons/clock";
  import type {
    WikiConflictsGroupBy,
    WikiConflictsInbox,
    WikiConflictsKindFilter,
    WikiConflictsStatusFilter,
  } from "../app/wiki-conflicts-inbox.svelte";
  import { wikiFindingStatus, type WikiFinding } from "../lib/wiki-conflicts-index";

  /** Sidebar findings list; selecting a row shows its comparison in the workbench tab. */
  let { inbox, onReveal }: {
    inbox: WikiConflictsInbox;
    onReveal: () => void;
  } = $props();

  const baseId = $props.id();
  let listbox = $state<HTMLDivElement | null>(null);
  const text = $derived(inbox.text);
  const optionId = (index: number) => `${baseId}-finding-${index}`;
  const groupOffsets = $derived(inbox.groups.reduce<number[]>((offsets, _group, index) => {
    offsets.push(index ? offsets[index - 1]! + inbox.groups[index - 1]!.findings.length : 0);
    return offsets;
  }, []));

  $effect(() => {
    const index = inbox.activeIndex;
    if (index < 0 || !listbox) return;
    void tick().then(() => document.getElementById(optionId(index))?.scrollIntoView?.({ block: "nearest" }));
  });

  function onKeydown(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowDown" || event.key === "j") inbox.move(1);
    else if (event.key === "ArrowUp" || event.key === "k") inbox.move(-1);
    else if (event.key === "Home") inbox.first();
    else if (event.key === "End") inbox.last();
    else if (event.key === "]") inbox.moveGroup(1);
    else if (event.key === "[") inbox.moveGroup(-1);
    else if (event.key === "Enter") onReveal();
    else if (event.key === " ") inbox.toggleBasket(inbox.activeFinding);
    else return;
    event.preventDefault();
  }

  const segmentClass = (pressed: boolean) => [
    "rounded-sm px-1.5 py-0.5 hover:bg-panel-hover",
    pressed ? "bg-panel-hover font-medium text-foreground" : "text-muted-foreground",
  ];
  const kinds = $derived<[WikiConflictsKindFilter, string][]>([
    ["all", text.kindAll], ["conflict", text.kindConflict], ["uncertainty", text.kindUncertainty], ["internal", text.kindInternal],
  ]);
  const statuses = $derived<[WikiConflictsStatusFilter, string][]>([
    ["open", text.statusOpen], ["fix-pending", text.statusFixPending], ["decided", text.statusDecided], ["stale", text.statusStale], ["all", text.statusAll],
  ]);
  const groupings = $derived<[WikiConflictsGroupBy, string][]>([["pair", text.groupPair], ["page", text.groupPage]]);

  function statusChip(finding: WikiFinding): string {
    if (finding.stale) return "";
    if (finding.reopened) return text.reopened;
    const status = wikiFindingStatus(finding);
    return status === "fix-pending" ? text.fixPending : status === "decided" ? text.decidedChip : "";
  }
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-wiki-conflicts-list>
  <div class="shrink-0 space-y-1 border-b border-border px-2 py-1.5 text-xs">
    <div class="flex flex-wrap items-center gap-0.5" role="group" aria-label={text.kindLabel}>
      {#each kinds as [value, label] (value)}
        <button type="button" class={segmentClass(inbox.kind === value)} aria-pressed={inbox.kind === value} onclick={() => inbox.kind = value}>{label}</button>
      {/each}
    </div>
    <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <div class="flex items-center gap-0.5" role="group" aria-label={text.statusLabel}>
        {#each statuses as [value, label] (value)}
          <button type="button" class={segmentClass(inbox.status === value)} aria-pressed={inbox.status === value} onclick={() => inbox.status = value}>{label}</button>
        {/each}
      </div>
      <div class="flex items-center gap-0.5" role="group" aria-label={text.groupLabel}>
        {#each groupings as [value, label] (value)}
          <button type="button" class={segmentClass(inbox.groupBy === value)} aria-pressed={inbox.groupBy === value} onclick={() => inbox.groupBy = value}>{label}</button>
        {/each}
      </div>
    </div>
    {#if inbox.branch}
      <span class="inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm border border-border px-1.5 py-0.5" data-wiki-branch-filter>
        <span class="text-muted-foreground">{text.branchLabel}:</span>
        <span class="min-w-0 truncate font-mono">{inbox.branch}</span>
        <button type="button" class="rounded-sm p-0.5 hover:bg-panel-hover" aria-label={text.clearBranch} title={text.clearBranch} onclick={() => inbox.clearBranch()}>
          <X class="h-3 w-3" aria-hidden="true" />
        </button>
      </span>
    {/if}
  </div>

  {#if !inbox.snapshot}
    <p class="px-3 py-4 text-xs text-muted-foreground">{text.noWiki}</p>
  {:else if !inbox.findings.length}
    <div class="space-y-2 px-3 py-4 text-xs text-muted-foreground" data-wiki-conflicts-empty>
      {#if inbox.snapshot.complete}
        <p class="font-medium text-foreground">{text.emptyComplete}</p>
        <p>{text.emptyCoverage}</p>
      {:else}
        <p role="status">{text.scanning}</p>
      {/if}
    </div>
  {:else}
    {#if !inbox.snapshot.complete || inbox.snapshot.truncated}
      <p class="shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted-foreground" role="note">
        {!inbox.snapshot.complete ? text.emptyIncomplete : ""}{!inbox.snapshot.complete && inbox.snapshot.truncated ? " " : ""}{inbox.snapshot.truncated ? text.truncated : ""}
      </p>
    {/if}
    {#if !inbox.rows.length}
      <p class="px-3 py-4 text-xs text-muted-foreground">{text.emptyFiltered}</p>
    {:else}
      <div
        bind:this={listbox}
        class="min-h-0 flex-1 overflow-auto py-1 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        role="listbox"
        tabindex="0"
        aria-label={text.inboxLabel}
        aria-activedescendant={inbox.activeIndex >= 0 ? optionId(inbox.activeIndex) : undefined}
        onkeydown={onKeydown}
      >
        {#each inbox.groups as group, groupIndex (group.key)}
          {@const offset = groupOffsets[groupIndex] ?? 0}
          <div role="group" aria-labelledby={`${baseId}-group-${groupIndex}`}>
            <div id={`${baseId}-group-${groupIndex}`} class="truncate px-3 pb-1 pt-2 font-medium text-muted-foreground" title={group.key.replace("\u0000", " ↔ ")}>{group.label} · {group.findings.length}</div>
            {#each group.findings as finding, index (finding.id)}
              {@const rowIndex = offset + index}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                id={optionId(rowIndex)}
                role="option"
                tabindex="-1"
                aria-selected={rowIndex === inbox.activeIndex}
                class={["flex min-w-0 cursor-default items-start gap-2 px-3 py-1.5 hover:bg-panel-hover", rowIndex === inbox.activeIndex ? "bg-panel-hover text-foreground" : ""]}
                onclick={() => { inbox.select(inbox.rows[rowIndex]?.key ?? null); onReveal(); listbox?.focus(); }}
              >
                <input
                  type="checkbox"
                  class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary disabled:opacity-30"
                  tabindex="-1"
                  checked={inbox.inBasket(finding)}
                  disabled={finding.stale || (!inbox.inBasket(finding) && inbox.basketFull)}
                  aria-label={inbox.inBasket(finding) ? text.basketRemove : text.basketAdd}
                  title={inbox.inBasket(finding) ? text.basketRemove : inbox.basketFull ? text.basketFull : text.basketAdd}
                  onclick={(event) => { event.stopPropagation(); inbox.toggleBasket(finding); }}
                  data-wiki-basket-toggle
                />
                {#if !finding.stale && wikiFindingStatus(finding) !== "open"}
                  <!-- Neutral: a verdict exists (fix awaiting recheck, accepted or deferred). -->
                  <Clock class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" data-wiki-finding-decided />
                {:else if finding.kind === "conflict"}
                  <TriangleAlert class={["mt-0.5 h-3.5 w-3.5 shrink-0", finding.stale ? "text-muted-foreground" : "text-tool-error"]} aria-hidden="true" />
                {:else}
                  <CircleQuestionMark class={["mt-0.5 h-3.5 w-3.5 shrink-0", finding.stale ? "text-muted-foreground" : "text-tool-warning"]} aria-hidden="true" />
                {/if}
                <span class="min-w-0 flex-1">
                  <span class={["line-clamp-2 break-words", finding.stale ? "text-muted-foreground" : ""]}>{finding.explanation}</span>
                  <span class="mt-0.5 block truncate font-mono text-muted-foreground">
                    {finding.kind === "conflict" ? text.conflict : text.uncertainty}{finding.stale ? ` · ${text.stale}` : ""}{statusChip(finding) ? ` · ${statusChip(finding)}` : ""} · L{finding.draft.startLine} ↔ L{finding.existing.startLine}
                  </span>
                </span>
              </div>
            {/each}
          </div>
        {/each}
      </div>
      {#if inbox.basket.length}
        <div class="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5 text-xs" data-wiki-basket-summary>
          <span class="min-w-0 flex-1 truncate font-medium" role="status">{text.basketSummary(inbox.basket.length, inbox.basketPages)}</span>
          <button type="button" class="rounded-sm px-1.5 py-0.5 text-muted-foreground hover:bg-panel-hover" onclick={() => inbox.clearBasket()} data-wiki-basket-clear>{text.basketClear}</button>
        </div>
      {/if}
      <p class="shrink-0 border-t border-border px-3 py-1 text-xs text-muted-foreground">{text.keyboardHint}</p>
    {/if}
  {/if}
</div>
