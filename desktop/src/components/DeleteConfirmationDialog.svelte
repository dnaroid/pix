<script lang="ts">
  import { dialogCancelButtonClass, dialogDestructiveButtonClass } from "../lib/dialog";
  import { activateModalDialog } from "../lib/modal-dialog";
  import { createDiagnosticLogger } from "../lib/diagnostic-logging";

  let { title, message, okLabel = "Delete", disabled = false, onconfirm, oncancel }: {
    title: string;
    message: string;
    okLabel?: string;
    disabled?: boolean;
    onconfirm: () => void;
    oncancel: () => void;
  } = $props();
  const ids = $props.id();
  const diagnostics = createDiagnosticLogger(() => ({ workspace: "" }));
  let dialog = $state<HTMLDialogElement>();
  let cancelButton = $state<HTMLButtonElement>();
  $effect(() => {
    if (!dialog) return;
    try { return activateModalDialog(dialog, () => cancelButton); }
    catch (error) { diagnostics.report(error); oncancel(); }
  });
</script>

<dialog
  bind:this={dialog}
  class="fixed inset-0 z-50 m-auto w-[min(400px,calc(100vw-32px))] max-h-[calc(100vh-32px)] overflow-auto rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-md backdrop:bg-overlay"
  aria-labelledby={`${ids}-title`}
  aria-describedby={`${ids}-message`}
  oncancel={(event) => { event.preventDefault(); oncancel(); }}
>
  <h2 id={`${ids}-title`} class="text-sm font-semibold">{title}</h2>
  <p id={`${ids}-message`} class="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{message}</p>
  <div class="mt-4 flex justify-end gap-2">
    <button bind:this={cancelButton} type="button" class={dialogCancelButtonClass} onclick={oncancel}>Cancel</button>
    <button type="button" class={dialogDestructiveButtonClass} {disabled} onclick={() => { if (!disabled) onconfirm(); }}>{okLabel}</button>
  </div>
</dialog>
