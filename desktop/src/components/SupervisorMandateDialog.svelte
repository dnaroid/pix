<script lang="ts">
  import { untrack } from "svelte";
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";
  import { SUPERVISOR_MANDATE_LIMITS as LIMITS, type SupervisorMandateResponse } from "../../../acp/src/acp/supervisor-contract";
  import type { SupervisorMandateDraft } from "../app/supervisor-mandate.svelte";
  import { dialogCancelButtonClass, dialogPrimaryButtonClass, modalBackdropClass } from "../lib/dialog";
  import { activateModalDialog } from "../lib/modal-dialog";
  import ModelThinkingAssignmentControl from "./ModelThinkingAssignmentControl.svelte";

  let { mandate, enable = false, saving, workspace, configOptions, visibleModelRefs,
    rememberedThinkingByModel, onVisibleModelsChange, onsave, oncancel, reportError }: {
    mandate: SupervisorMandateResponse;
    /** Opened from "Set up": the enable box starts checked. */
    enable?: boolean;
    saving: boolean;
    workspace: string;
    configOptions: readonly SessionConfigOption[];
    visibleModelRefs?: readonly string[];
    rememberedThinkingByModel: Readonly<Record<string, string>>;
    onVisibleModelsChange: (refs: readonly string[]) => Promise<void> | void;
    onsave: (draft: SupervisorMandateDraft) => void;
    oncancel: () => void;
    reportError: (error: unknown) => void;
  } = $props();
  const ids = $props.id();
  const initial = untrack(() => mandate);
  let enabled = $state(untrack(() => enable || initial.enabled));
  let maxConcurrent = $state(initial.maxConcurrent);
  let maxReworkRounds = $state(initial.maxReworkRounds);
  let stalledAfterMinutes = $state(initial.stalledAfterMinutes);
  let budgetTokens = $state(initial.budgetTokens);
  let workerModelRef = $state(initial.workerModelRef ?? "");
  let policy = $state(initial.policy);
  let dialog = $state<HTMLDialogElement>();
  let first = $state<HTMLInputElement>();

  const clamp = (value: number, range: { min: number; max: number; default: number }) =>
    Number.isInteger(value) ? Math.min(range.max, Math.max(range.min, value)) : range.default;

  $effect(() => {
    if (!dialog) return;
    try {
      return activateModalDialog(dialog, () => first);
    } catch (error) { reportError(error); oncancel(); }
  });

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (saving) return;
    onsave({
      enabled,
      maxConcurrent: clamp(maxConcurrent, LIMITS.maxConcurrent),
      maxReworkRounds: clamp(maxReworkRounds, LIMITS.maxReworkRounds),
      stalledAfterMinutes: clamp(stalledAfterMinutes, LIMITS.stalledAfterMinutes),
      budgetTokens: budgetTokens ?? null,
      workerModelRef,
      policy,
    });
  }

  const fieldClass = "mt-1 h-7 w-full rounded-md border border-input bg-background px-2 font-mono text-xs";
</script>

<dialog bind:this={dialog} class={modalBackdropClass}
  aria-labelledby={`${ids}-title`} oncancel={(event) => { event.preventDefault(); oncancel(); }}>
  <form class="w-[min(480px,calc(100vw-32px))] max-h-[calc(100vh-32px)] overflow-auto rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-md"
    onsubmit={submit}>
    <h2 id={`${ids}-title`} class="text-sm font-semibold">Supervisor Mandate</h2>
    <p class="mt-1 text-xs text-muted-foreground">
      While enabled and not paused, the supervisor may send follow-ups, cancel turns and close the tasks of managed sessions within these limits.
    </p>
    <label class="mt-3 flex items-center gap-2 text-xs">
      <input bind:this={first} type="checkbox" class="h-3.5 w-3.5 accent-primary" bind:checked={enabled} disabled={saving} />
      Allow the supervisor to act on managed sessions
    </label>
    <div class="mt-3 grid grid-cols-3 gap-3">
      <label class="block text-xs text-muted-foreground">Parallel sessions
        <input type="number" class={fieldClass} bind:value={maxConcurrent} disabled={saving} required
          min={LIMITS.maxConcurrent.min} max={LIMITS.maxConcurrent.max} step="1" />
      </label>
      <label class="block text-xs text-muted-foreground">Rework rounds
        <input type="number" class={fieldClass} bind:value={maxReworkRounds} disabled={saving} required
          min={LIMITS.maxReworkRounds.min} max={LIMITS.maxReworkRounds.max} step="1" />
      </label>
      <label class="block text-xs text-muted-foreground">Stalled after, min
        <input type="number" class={fieldClass} bind:value={stalledAfterMinutes} disabled={saving} required
          min={LIMITS.stalledAfterMinutes.min} max={LIMITS.stalledAfterMinutes.max} step="1" />
      </label>
    </div>
    <label class="mt-3 block text-xs text-muted-foreground">Token budget (rolling 24 h)
      <input type="number" class={fieldClass} bind:value={budgetTokens} disabled={saving}
        min={LIMITS.budgetTokens.min} max={LIMITS.budgetTokens.max} step="1"
        placeholder="No limit" aria-describedby={`${ids}-budget-help`} />
    </label>
    <p id={`${ids}-budget-help`} class="mt-1 text-xs text-muted-foreground">Leave empty for no limit. The budget only limits automatic supervisor wakes.</p>
    <ModelThinkingAssignmentControl
      class="mt-3"
      label="Default worker model"
      triggerLabel="Default worker model and effort"
      help="For supervisor-launched plans and prompts. Reset to use the session default."
      selectionDescription="Choose the default model and effort for supervisor-launched plans and prompts."
      bind:value={workerModelRef}
      {workspace}
      {configOptions}
      {visibleModelRefs}
      {rememberedThinkingByModel}
      {onVisibleModelsChange}
      disabled={saving}
    />
    <label for={`${ids}-policy`} class="mt-3 block text-xs text-muted-foreground">Policy: what to escalate, priorities, areas not to touch</label>
    <textarea id={`${ids}-policy`} bind:value={policy} disabled={saving} rows={5} maxlength={20000} spellcheck="false"
      class="mt-1 w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs"></textarea>
    <div class="mt-4 flex justify-end gap-2">
      <button type="button" class={dialogCancelButtonClass} onclick={oncancel}>Cancel</button>
      <button type="submit" class={dialogPrimaryButtonClass} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
    </div>
  </form>
</dialog>
