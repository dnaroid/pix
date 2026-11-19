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
  // Reply buttons belong to the latest turn only. Checklist rows stay usable on
  // older unsent blocks, so the user can still run some offered steps later.
  const enabled = $derived(!state.submitting && !state.submitted);
  const buttonsEnabled = $derived(active && enabled);
  // Model defaults are a recommendation for the latest turn only; an expired
  // block shows just the choices the user actually made on it.
  const showSelection = $derived(active || state.submitted || state.edited);

  function selectingText(event: MouseEvent): boolean {
    const selection = window.getSelection();
    return !!selection && !selection.isCollapsed && (event.currentTarget as Node).contains(selection.anchorNode);
  }

  function toggle(index: number): void {
    if (!enabled) return;
    const base = showSelection ? state.selected : [];
    state.edited = true;
    state.selected = base.includes(index) ? base.filter((value) => value !== index) : [...base, index];
  }

  async function submit(button?: number): Promise<void> {
    if (button !== undefined ? !buttonsEnabled : !enabled || !showSelection) return;
    // Compatibility buttons preserve the full prompt, not just its short label.
    if (button !== undefined) state.selected = [button];
    if (!state.selected.length) return;
    state.submitting = true;
    state.error = "";
    try {
      await onSubmit(button !== undefined ? (actions.items[button]!.prompt ?? actions.items[button]!.label) : choiceActionsPrompt(actions.submitLabel, actions.items, state.selected));
      state.submitted = true;
    } catch (cause) {
      state.error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      state.submitting = false;
    }
  }
</script>

{#if actions.buttons}
<div class="my-3 flex flex-wrap items-center gap-2" role="group" aria-label={actions.submitLabel} data-choice-actions data-choice-buttons>
  {#each actions.items as item, index}
    {@const pressed = state.submitted && state.selected.includes(index)}
    <button
      class={[
        "rounded-md px-3 py-1 text-xs font-medium disabled:cursor-default",
        index === 0 ? "bg-primary text-primary-foreground" : "border border-border/70 text-foreground",
        buttonsEnabled && (index === 0 ? "hover:opacity-90" : "hover:bg-panel-hover"),
        !buttonsEnabled && !pressed && "opacity-40",
      ]}
      type="button"
      title={item.prompt}
      disabled={!buttonsEnabled}
      aria-pressed={state.submitted ? pressed : undefined}
      data-choice-button={index}
      onclick={() => submit(index)}
    >{item.label}</button>
  {/each}
  {#if state.error}<p class="w-full text-xs text-destructive" role="alert">{state.error}</p>{/if}
</div>
{:else}
<div class="my-3 w-full rounded-md border border-border/70" data-choice-actions>
  <div class="divide-y divide-border/70" role="group" aria-label={actions.submitLabel}>
    {#each actions.items as item, index}
      {@const isSelected = showSelection && state.selected.includes(index)}
      <!-- Not a <button>: WebKit cannot select text inside buttons, and labels must stay copyable. -->
      <div
        class={[
          "flex w-full cursor-default items-start gap-2.5 px-2.5 py-2 text-left text-sm transition-colors focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
          isSelected ? "bg-panel-selected" : enabled && "hover:bg-panel-hover",
        ]}
        role="checkbox"
        tabindex={enabled ? 0 : -1}
        aria-checked={isSelected}
        aria-disabled={!enabled || undefined}
        data-choice-action={index}
        onclick={(event) => {
          // A double-click selects a word: undo the toggle made by its first click.
          if (event.detail === 2) toggle(index);
          else if (event.detail < 2 && !selectingText(event)) toggle(index);
        }}
        onkeydown={(event) => {
          if (event.key !== " " && event.key !== "Enter") return;
          event.preventDefault();
          toggle(index);
        }}
      >
        <span class={[
          "mt-0.5 grid size-4 shrink-0 place-items-center rounded-sm border",
          isSelected ? "border-primary" : "border-muted-foreground/50",
          (!enabled || !active) && "opacity-60",
        ]}>{#if isSelected}<Check class="size-3 text-primary" strokeWidth={2.4} />{/if}</span>
        <span class={[
          "select-text min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground",
          (!enabled || !active) && !isSelected && "opacity-60",
        ]}>
          <span class="text-muted-foreground tabular-nums">{index + 1}.</span> {item.label}
        </span>
      </div>
    {/each}
  </div>
  {#if !state.submitted && (active || state.edited)}
    <div class="flex items-center gap-3 border-t border-border/70 px-2.5 py-2">
      <button
        class="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
        type="button"
        disabled={!enabled || !showSelection || !state.selected.length}
        data-choice-actions-submit
        onclick={() => submit()}
      >{actions.submitLabel}</button>
      <span class="text-xs tabular-nums text-muted-foreground" aria-live="polite">{state.selected.length} / {actions.items.length}</span>
    </div>
  {/if}
  {#if state.error}<p class="px-2.5 pb-2 text-xs text-destructive" role="alert">{state.error}</p>{/if}
</div>
{/if}
