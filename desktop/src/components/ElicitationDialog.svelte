<script lang="ts">
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
    <span class="text-[11px] font-semibold tracking-[0.08em] text-primary uppercase">Pix needs your input</span>
    <h2 id="elicitation-title" class="mt-2 mb-[22px] text-base leading-snug font-medium whitespace-pre-wrap text-foreground">{message}</h2>
    <label class="grid gap-2">
      <span class="text-xs font-semibold">{field.label}</span>
      {#if field.description}<small class="text-muted-foreground">{field.description}</small>{/if}
      {#if field.type === "select"}
        <select
          bind:this={fieldControl}
          class="min-h-[34px] w-full rounded-md border border-input bg-panel-strong px-2.5 py-2 text-foreground transition-colors outline-none hover:border-ring focus:border-ring focus:ring-2 focus:ring-ring/20"
          value={String(field.value)}
          onchange={(event) => onValueChange(event.currentTarget.value)}
        >
          {#each field.options as option}<option value={option}>{option}</option>{/each}
        </select>
      {:else if field.type === "boolean"}
        <input
          bind:this={fieldControl}
          class="h-5 w-5 accent-primary transition-shadow hover:ring-2 hover:ring-ring/30"
          type="checkbox"
          checked={Boolean(field.value)}
          onchange={(event) => onValueChange(event.currentTarget.checked)}
        />
      {:else}
        <textarea
          bind:this={fieldControl}
          class="min-h-[34px] w-full resize-y rounded-md border border-input bg-panel-strong px-2.5 py-2 text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
          rows="5"
          value={String(field.value)}
          oninput={(event) => onValueChange(event.currentTarget.value)}
        ></textarea>
      {/if}
    </label>
    <div class="mt-[22px] flex justify-end gap-2.5">
      <button
        class="rounded-md border border-border bg-secondary px-2.5 py-1 font-medium text-secondary-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        type="button"
        onclick={() => onAnswer(false)}
      >Cancel</button>
      <button
        class="rounded-md border border-primary bg-primary px-2.5 py-1 font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        type="submit"
      >Continue</button>
    </div>
  </form>
</dialog>
