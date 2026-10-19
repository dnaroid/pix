<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import { untrack } from "svelte";
  import { choiceActionsPrompt, type ChoiceActions } from "../lib/choice-actions";
  import { choiceActionsStateCache } from "../lib/choice-actions-state.svelte";

  let {
    actions,
    active,
    onSubmit,
    stateScope,
    blockIndex = 0,
  }: {
    actions: ChoiceActions;
    /** Only the latest assistant message accepts a choice. */
    active: boolean;
    onSubmit: (text: string) => Promise<"sent" | "queued">;
    stateScope?: string;
    blockIndex?: number;
  } = $props();

  // The parent keys by scope and content. Remounting an unchanged block restores
  // its selection and pending/submitted state rather than the model defaults.
  const state = untrack(() => choiceActionsStateCache.get(stateScope, blockIndex, actions));
  const enabled = $derived(active && !state.submitting && !state.submitted);

  function toggle(index: number): void {
    if (!enabled) return;
    state.selected = state.selected.includes(index) ? state.selected.filter((value) => value !== index) : [...state.selected, index];
  }

  async function submit(): Promise<void> {
    if (!enabled || !state.selected.length) return;
    state.submitting = true;
    state.error = "";
    try {
      await onSubmit(choiceActionsPrompt(actions.submitLabel, actions.items, state.selected));
      state.submitted = true;
    } catch (cause) {
      state.error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      state.submitting = false;
    }
  }
</script>

<div class="my-3 w-full rounded-md border border-border/70" data-choice-actions>
  <div class="divide-y divide-border/70" role="group" aria-label={actions.submitLabel}>
    {#each actions.items as item, index}
      {@const isSelected = state.selected.includes(index)}
      <button
        class={[
          "flex w-full items-start gap-2.5 px-2.5 py-2 text-left text-sm transition-colors focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
          isSelected ? "bg-panel-selected" : enabled && "hover:bg-panel-hover",
          !enabled && "cursor-default",
        ]}
        type="button"
        role="checkbox"
        aria-checked={isSelected}
        aria-disabled={!enabled || undefined}
        data-choice-action={index}
        onclick={() => toggle(index)}
      >
        <span class={[
          "mt-0.5 grid size-4 shrink-0 place-items-center rounded-sm border",
          isSelected ? "border-primary" : "border-muted-foreground/50",
          !enabled && "opacity-60",
        ]}>{#if isSelected}<Check class="size-3 text-primary" strokeWidth={2.4} />{/if}</span>
        <span class={[
          "min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground",
          !enabled && !isSelected && "opacity-60",
        ]}>
          <span class="text-muted-foreground tabular-nums">{index + 1}.</span> {item.label}
        </span>
      </button>
    {/each}
  </div>
  {#if active && !state.submitted}
    <div class="flex items-center gap-3 border-t border-border/70 px-2.5 py-2">
      <button
        class="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
        type="button"
        disabled={!enabled || !state.selected.length}
        data-choice-actions-submit
        onclick={submit}
      >{actions.submitLabel}</button>
      <span class="text-xs tabular-nums text-muted-foreground" aria-live="polite">{state.selected.length} / {actions.items.length}</span>
    </div>
  {/if}
  {#if state.error}<p class="px-2.5 pb-2 text-xs text-destructive" role="alert">{state.error}</p>{/if}
</div>
