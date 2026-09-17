<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import type { ElicitationField } from "../lib/elicitation";
  import { activateModalDialog } from "../lib/modal-dialog";

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
  let fieldControl = $state<HTMLSelectElement | HTMLInputElement | HTMLTextAreaElement | null>(null);

  $effect(() => {
    const dialog = dialogElement;
    if (!dialog) return;
    return activateModalDialog(dialog, () => fieldControl);
  });

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    onAnswer(true);
  }
</script>

<dialog
  bind:this={dialogElement}
  class="fixed inset-0 z-50 m-auto h-screen max-h-none w-screen max-w-none place-items-center bg-transparent p-6 text-foreground backdrop:bg-overlay open:grid"
  aria-labelledby="elicitation-title"
  oncancel={(event) => { event.preventDefault(); onAnswer(false); }}
  onclick={(event) => { if (event.target === event.currentTarget) onAnswer(false); }}
>
  <form class="w-[min(520px,100%)] rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-md" onsubmit={submit}>
    <span class="text-xs font-semibold tracking-[0.08em] text-primary uppercase">Pix needs your input</span>
    <h2 id="elicitation-title" class="mt-2 mb-4 text-sm leading-snug font-medium whitespace-pre-wrap text-foreground">{message}</h2>
    <label class="grid gap-1.5">
      <span class="text-xs font-semibold">{field.label}</span>
      {#if field.description}<small class="text-muted-foreground">{field.description}</small>{/if}
      {#if field.type === "select"}
        <div class="relative">
          <select
            bind:this={fieldControl}
            class="h-9 w-full appearance-none rounded-md border border-input bg-panel-strong py-0 pr-8 pl-2.5 text-sm text-foreground outline-none hover:bg-panel-hover focus:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            value={String(field.value)}
            onchange={(event) => onValueChange(event.currentTarget.value)}
          >
            {#each field.options as option}<option value={option}>{option}</option>{/each}
          </select>
          <ChevronDown class="pointer-events-none absolute top-1/2 right-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        </div>
      {:else if field.type === "boolean"}
        <div class="flex items-center gap-2">
          <input
            bind:this={fieldControl}
            class="h-4 w-4 accent-primary transition-shadow enabled:hover:ring-2 enabled:hover:ring-ring/30 focus-visible:outline-2 focus-visible:outline-ring"
            type="checkbox"
            checked={Boolean(field.value)}
            onchange={(event) => onValueChange(event.currentTarget.checked)}
          />
        </div>
      {:else}
        <textarea
          bind:this={fieldControl}
          class="min-h-24 w-full resize-y rounded-md border border-input bg-panel-strong px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          rows="4"
          value={String(field.value)}
          oninput={(event) => onValueChange(event.currentTarget.value)}
        ></textarea>
      {/if}
    </label>
    <div class="mt-5 flex justify-end gap-2">
      <button
        class="h-8 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        type="button"
        onclick={() => onAnswer(false)}
      >Cancel</button>
      <button
        class="inline-flex h-8 min-w-20 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        type="submit"
      >Continue</button>
    </div>
  </form>
</dialog>
