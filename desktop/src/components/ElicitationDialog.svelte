<script lang="ts">
  import { dialogCancelButtonClass, dialogPrimaryButtonClass, modalBackdropClass } from "../lib/dialog";
  import Check from "@lucide/svelte/icons/check";
  import type { ElicitationField } from "../lib/elicitation";
  import { activateModalDialog } from "../lib/modal-dialog";
  import TaskFieldSelect from "./TaskFieldSelect.svelte";

  let {
    message,
    field,
    onValueChange,
    onAnswer,
  }: {
    message: string;
    field: ElicitationField;
    onValueChange: (value: string | boolean) => void;
    onAnswer: (accepted: boolean) => void;
  } = $props();

  let dialogElement = $state<HTMLDialogElement | null>(null);
  let fieldControl = $state<HTMLInputElement | HTMLTextAreaElement | null>(null);

  $effect(() => {
    const dialog = dialogElement;
    if (!dialog) return;
    // Select fields render the Pix dropdown trigger instead of a bindable native control.
    return activateModalDialog(dialog, () => fieldControl ?? dialog.querySelector<HTMLElement>("[aria-haspopup='listbox']"));
  });

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    onAnswer(true);
  }
</script>

<dialog
  bind:this={dialogElement}
  class={modalBackdropClass}
  aria-labelledby="elicitation-title"
  oncancel={(event) => { event.preventDefault(); onAnswer(false); }}
  onclick={(event) => { if (event.target === event.currentTarget) onAnswer(false); }}
>
  <form class="max-h-[90vh] w-[min(520px,100%)] overflow-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-md" onsubmit={submit}>
    <span class="text-xs font-semibold tracking-[0.08em] text-primary uppercase">Pix needs your input</span>
    <h2 id="elicitation-title" class="mt-2 mb-4 text-sm leading-snug font-medium whitespace-pre-wrap text-foreground">{message}</h2>
    <!-- A label would forward clicks inside the dropdown popup back to its trigger. -->
    <svelte:element this={field.type === "select" ? "div" : "label"} class="grid gap-1.5">
      {#if field.type !== "boolean"}
        <span class="text-xs font-semibold" class:sr-only={field.label.trim() === message.trim()}>{field.label}</span>
      {/if}
      {#if field.description}<small class="text-muted-foreground">{field.description}</small>{/if}
      {#if field.type === "select"}
        <TaskFieldSelect
          value={String(field.value)}
          options={field.options.map((option) => ({ value: option, label: option }))}
          ariaLabel={field.label}
          searchable={field.options.length > 12}
          searchPlaceholder="Search…"
          emptyLabel="No matching options"
          onChange={(value) => onValueChange(value)}
        />
      {:else if field.type === "boolean"}
        <span class="mt-0.5 inline-flex items-center gap-2">
          <span class="relative grid size-4 shrink-0 place-items-center">
            <input
              bind:this={fieldControl}
              class="peer size-4 appearance-none rounded-sm border border-input bg-panel-strong transition-colors hover:border-ring checked:border-primary checked:bg-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              type="checkbox"
              aria-label={field.label}
              checked={Boolean(field.value)}
              onchange={(event) => onValueChange(event.currentTarget.checked)}
            />
            <Check class="pointer-events-none absolute size-3 text-primary-foreground opacity-0 transition-opacity peer-checked:opacity-100" strokeWidth={2.5} aria-hidden="true" />
          </span>
          <span class="text-xs font-semibold" class:sr-only={field.label.trim() === message.trim()}>{field.label}</span>
        </span>
      {:else if field.type === "editor"}
        <textarea
          bind:this={fieldControl}
          class="min-h-24 w-full rounded-md border border-input bg-panel-strong px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          rows="4"
          value={String(field.value)}
          oninput={(event) => onValueChange(event.currentTarget.value)}
        ></textarea>
      {:else}
        <input
          bind:this={fieldControl}
          class="h-9 w-full rounded-md border border-input bg-panel-strong px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          type="text"
          value={String(field.value)}
          oninput={(event) => onValueChange(event.currentTarget.value)}
        />
      {/if}
    </svelte:element>
    <div class="mt-5 flex justify-end gap-2">
      <button
        class={dialogCancelButtonClass}
        type="button"
        onclick={() => onAnswer(false)}
      >Cancel</button>
      <button
        class={dialogPrimaryButtonClass}
        type="submit"
      >Continue</button>
    </div>
  </form>
</dialog>
