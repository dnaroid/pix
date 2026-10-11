<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import X from "@lucide/svelte/icons/x";
  import type { Attachment } from "../lib/attachments";
  import type { ElicitationField } from "../lib/elicitation";
  import { activateModalDialog } from "../lib/modal-dialog";

  let {
    message,
    field,
    editAttachments,
    onRemoveAttachment,
    onValueChange,
    onAnswer,
  }: {
    message: string;
    field: ElicitationField;
    editAttachments?: readonly Attachment[];
    onRemoveAttachment?: (id: string) => void;
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
  <form class="max-h-[90vh] w-[min(520px,100%)] overflow-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-md" onsubmit={submit}>
    <span class="text-xs font-semibold tracking-[0.08em] text-primary uppercase">Pix needs your input</span>
    <h2 id="elicitation-title" class="mt-2 mb-4 text-sm leading-snug font-medium whitespace-pre-wrap text-foreground">{message}</h2>
    <label class="grid gap-1.5">
      {#if field.type !== "boolean"}
        <span class="text-xs font-semibold" class:sr-only={field.label.trim() === message.trim()}>{field.label}</span>
      {/if}
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
    </label>
    {#if editAttachments}
      <p class="mt-3 text-xs text-muted-foreground">Resends in this conversation from this point. Later messages leave the active branch; files are not reverted.</p>
      {#each editAttachments as attachment (attachment.id)}
        <div class="mt-2 flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs">
          <span class="min-w-0 flex-1 truncate">{attachment.name}</span>
          <button type="button" class="grid size-6 place-items-center rounded-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Remove ${attachment.name}`} onclick={() => onRemoveAttachment?.(attachment.id)}><X class="size-3.5" aria-hidden="true" /></button>
        </div>
      {/each}
    {/if}
    <div class="mt-5 flex justify-end gap-2">
      <button
        class="h-8 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        type="button"
        onclick={() => onAnswer(false)}
      >Cancel</button>
      <button
        class="inline-flex h-8 min-w-20 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        type="submit"
        disabled={editAttachments !== undefined && !String(field.value).trim() && editAttachments.length === 0}
      >{editAttachments !== undefined ? "Save and resend" : "Continue"}</button>
    </div>
  </form>
</dialog>
