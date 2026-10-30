<script lang="ts">
  import { tick } from "svelte";
  import {
    KNOWLEDGE_FINDING_VERDICTS, MAX_KNOWLEDGE_DECISION_NOTE_CHARS, type KnowledgeFindingVerdict,
  } from "../../../acp/src/knowledge/decisions";
  import { wikiDecisionInput, type WikiFindingDecisionInput } from "../app/wiki-finding-decision";
  import { wikiFindingStatus, type WikiFinding } from "../lib/wiki-conflicts-index";
  import { wikiColumnVerdict, wikiVerdictLabel, type WikiConflictsText } from "./wiki-conflicts-text";

  /** Verdicts 1–5 for one finding; hotkeys work while focus is inside the comparison tab. */
  let { finding, text, deciding = false, sidesInColumns = false, retryDecision, onDecide, onCreateTask, onOpenTask }: {
    finding: WikiFinding;
    /** The comparison columns render the side buttons; hotkeys 1/2 still work here. */
    sidesInColumns?: boolean;
    text: WikiConflictsText;
    deciding?: boolean;
    /** Last attempted operation (null = clear); without it the surviving verdict is rewritten. */
    retryDecision?: WikiFindingDecisionInput | null;
    onDecide: (decision: WikiFindingDecisionInput | null) => void | Promise<void>;
    /** Explicit task creation for a deferred finding; absent when tasks are unavailable. */
    onCreateTask?: () => void | Promise<void>;
    onOpenTask?: (taskId: string) => void | Promise<void>;
  } = $props();

  let root = $state<HTMLElement>();
  let noteInput = $state<HTMLInputElement>();
  /** Optional rationale for any verdict; required only for «false positive». */
  let note = $state("");
  let noteRequired = $state(false);

  const help: Record<KnowledgeFindingVerdict, string> = $derived({
    "side-a": text.verdictHelp.side, "side-b": text.verdictHelp.side, "different-scope": text.verdictHelp.differentScope,
    "false-positive": text.verdictHelp.falsePositive, deferred: text.verdictHelp.deferred,
  });
  // Keys 1/2 follow the displayed columns (left/right), not the canonical side order.
  const ordered = $derived([wikiColumnVerdict(finding, 0), wikiColumnVerdict(finding, 1),
    ...KNOWLEDGE_FINDING_VERDICTS.filter(verdict => verdict !== "side-a" && verdict !== "side-b")]);
  const options = $derived(ordered.map(verdict => ({
    verdict, label: wikiVerdictLabel(text, finding, verdict), help: help[verdict],
  })));
  const current = $derived(finding.decision);

  // Another finding or a newly saved note replaces the unsaved draft.
  $effect(() => {
    void finding.id;
    note = current?.note ?? "";
    noteRequired = false;
  });

  const noteDirty = $derived(!!current && note.trim() !== (current.note ?? ""));

  /** Records a verdict with the current rationale; also used by the comparison column buttons. */
  export async function choose(verdict: KnowledgeFindingVerdict): Promise<void> {
    if (deciding) return;
    const trimmed = note.trim();
    if (verdict === "false-positive" && !trimmed) {
      noteRequired = true;
      await tick();
      noteInput?.focus();
      return;
    }
    noteRequired = false;
    // Re-choosing «deferred» keeps the linked task.
    const taskId = verdict === "deferred" && current?.verdict === "deferred" ? current.taskId : undefined;
    await onDecide({ verdict, ...(trimmed ? { note: trimmed } : {}), ...(taskId ? { taskId } : {}) });
  }

  async function submitNote(): Promise<void> {
    if (noteRequired) await choose("false-positive");
    else if (current && noteDirty) await choose(current.verdict);
  }

  function editable(target: EventTarget | null): boolean {
    return target instanceof HTMLElement
      && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
  }

  // Bind hotkeys to the enclosing tab only, so typing elsewhere never records a verdict.
  $effect(() => {
    const scope = root?.closest<HTMLElement>("[data-wiki-conflicts-tab]");
    if (!scope) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || editable(event.target)) return;
      const index = Number(event.key) - 1;
      const option = Number.isInteger(index) ? options[index] : undefined;
      if (!option) return;
      event.preventDefault();
      void choose(option.verdict);
    };
    scope.addEventListener("keydown", onKey);
    return () => scope.removeEventListener("keydown", onKey);
  });

  const buttonClass = (active: boolean) => [
    "inline-flex min-w-0 items-center gap-1.5 rounded-sm border px-2 py-1 text-xs hover:bg-panel-hover disabled:opacity-40",
    active ? "border-foreground/40 bg-panel-hover font-medium" : "border-border",
  ];
</script>

<div bind:this={root} class="shrink-0 space-y-2 border-b border-border px-4 py-2 text-xs" role="group" aria-label={text.decisionLabel} data-wiki-decision-bar>
  <div class="flex min-w-0 flex-wrap items-center gap-1.5">
    <span class="mr-1 font-medium text-muted-foreground">{text.decisionLabel}</span>
    {#each options as option, index (option.verdict)}
      {#if !(sidesInColumns && index < 2)}
      <button type="button" class={buttonClass(current?.verdict === option.verdict)} disabled={deciding}
        aria-pressed={current?.verdict === option.verdict} aria-keyshortcuts={String(index + 1)} title={option.help}
        onclick={() => void choose(option.verdict)} data-wiki-verdict={option.verdict}>
        <kbd class="font-mono text-xs text-muted-foreground">{index + 1}</kbd>
        <span class="truncate">{option.label}</span>
      </button>
      {/if}
    {/each}
    {#if current}
      <button type="button" class="rounded-sm px-2 py-1 text-muted-foreground hover:bg-panel-hover hover:text-foreground disabled:opacity-40"
        disabled={deciding} onclick={() => void onDecide(null)} data-wiki-clear-decision>{text.clearDecision}</button>
    {/if}
    {#if current?.verdict === "deferred"}
      {#if current.taskId && onOpenTask}
        <button type="button" class={buttonClass(false)} onclick={() => void onOpenTask?.(current.taskId!)} data-wiki-open-task>{text.openTask}</button>
      {:else if !current.taskId && onCreateTask}
        <button type="button" class={buttonClass(false)} disabled={deciding} title={text.createTaskHelp}
          onclick={() => void onCreateTask?.()} data-wiki-create-task>{text.createTask}</button>
      {/if}
    {/if}
    {#if deciding}<span class="text-muted-foreground" role="status">{text.deciding}</span>{/if}
  </div>

  <form class="flex min-w-0 items-center gap-2" onsubmit={(event) => { event.preventDefault(); void submitNote(); }}>
    <label class="shrink-0 text-muted-foreground" for={`wiki-decision-note-${finding.id}`}>{text.noteLabel}</label>
    <input id={`wiki-decision-note-${finding.id}`} bind:this={noteInput} bind:value={note}
      class={["min-w-0 flex-1 rounded-sm border bg-background px-2 py-1", noteRequired ? "border-tool-warning" : "border-border"]}
      maxlength={MAX_KNOWLEDGE_DECISION_NOTE_CHARS} placeholder={noteRequired ? text.notePlaceholder : text.noteOptionalPlaceholder}
      aria-invalid={noteRequired && !note.trim()} disabled={deciding}
      onkeydown={(event) => { if (event.key === "Escape") { event.preventDefault(); note = current?.note ?? ""; noteRequired = false; } }}
      data-wiki-decision-note />
    {#if noteRequired}
      <button type="submit" class={buttonClass(false)} disabled={deciding || !note.trim()}>{text.saveDecision}</button>
      <button type="button" class="rounded-sm px-2 py-1 hover:bg-panel-hover" onclick={() => { noteRequired = false; }}>{text.cancel}</button>
    {:else if noteDirty}
      <button type="submit" class={buttonClass(false)} disabled={deciding} data-wiki-save-note>{text.saveDecision}</button>
    {/if}
  </form>
  {#if noteRequired}<p class="text-tool-warning" role="status">{text.noteRequired}</p>{/if}

  {#if !finding.stale && finding.reopened}
    <p class="text-tool-warning" title={text.reopenedHelp} data-wiki-decision-reopened>{text.reopened}. {text.reopenedHelp}</p>
  {:else if !finding.stale && wikiFindingStatus(finding) === "fix-pending"}
    <p class="text-muted-foreground" data-wiki-decision-fix-pending>{text.fixPending}. {text.fixPendingHelp}</p>
  {/if}

  {#if finding.decisionPartial}
    <p class="flex flex-wrap items-center gap-2 text-tool-warning" role="alert" data-wiki-decision-partial>
      {text.decisionPartial}
      <button type="button" class="rounded-sm border border-border px-2 py-0.5 text-foreground hover:bg-panel-hover disabled:opacity-40"
        disabled={deciding}
        onclick={() => void onDecide(retryDecision !== undefined ? retryDecision
          : current ? wikiDecisionInput(current) : null)}>
        {text.retryDecision}
      </button>
    </p>
  {/if}
</div>
