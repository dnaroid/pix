<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import { untrack } from "svelte";
  import { choiceActionsPrompt, type ChoiceActions } from "../lib/choice-actions";

  let {
    actions,
    active,
    onSubmit,
  }: {
    actions: ChoiceActions;
    /** Only the latest assistant message accepts a choice. */
    active: boolean;
    onSubmit: (text: string) => Promise<"sent" | "queued">;
  } = $props();

  // Initial selection comes from the model's [x] recommendations; the parent
  // keys this component by block content, so later edits remount it.
  let selected = $state<number[]>(untrack(() => actions.items.flatMap((item, index) => item.checked ? [index] : [])));
  let submitting = $state(false);
  let submitted = $state(false);
  let error = $state("");
  const enabled = $derived(active && !submitting && !submitted);

  function toggle(index: number): void {
    if (!enabled) return;
    selected = selected.includes(index) ? selected.filter((value) => value !== index) : [...selected, index];
  }

  async function submit(): Promise<void> {
    if (!enabled || !selected.length) return;
    submitting = true;
    error = "";
    try {
      await onSubmit(choiceActionsPrompt(actions.submitLabel, actions.items, selected));
      submitted = true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      submitting = false;
    }
  }
</script>

<div class="my-3 w-full rounded-md border border-border/70" data-choice-actions>
  <div class="divide-y divide-border/70" role="group" aria-label={actions.submitLabel}>
    {#each actions.items as item, index}
      {@const isSelected = selected.includes(index)}
      <button
        class={[
          "flex w-full items-start gap-2.5 px-2.5 py-2 text-left text-sm transition-colors focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
          isSelected ? "bg-panel-selected" : enabled && "hover:bg-panel-hover",
          !enabled && "cursor-default opacity-60",
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
        ]}>{#if isSelected}<Check class="size-3 text-primary" strokeWidth={2.4} />{/if}</span>
        <span class="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground">
          <span class="text-muted-foreground tabular-nums">{index + 1}.</span> {item.label}
        </span>
      </button>
    {/each}
  </div>
  {#if active && !submitted}
    <div class="flex items-center gap-3 border-t border-border/70 px-2.5 py-2">
      <button
        class="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
        type="button"
        disabled={!enabled || !selected.length}
        data-choice-actions-submit
        onclick={submit}
      >{actions.submitLabel}</button>
      <span class="text-xs tabular-nums text-muted-foreground" aria-live="polite">{selected.length} / {actions.items.length}</span>
    </div>
  {/if}
  {#if error}<p class="px-2.5 pb-2 text-xs text-destructive" role="alert">{error}</p>{/if}
</div>
