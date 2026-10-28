<script lang="ts">
  import { dialogCancelButtonClass, dialogPrimaryButtonClass, modalBackdropClass } from "../lib/dialog";
  import { activateModalDialog } from "../lib/modal-dialog";
  import { untrack } from "svelte";

  let { title, saving, onconfirm, oncancel, reportError }: {
    title: string;
    saving: boolean;
    onconfirm: (name: string) => void;
    oncancel: () => void;
    reportError: (error: unknown) => void;
  } = $props();
  const ids = $props.id();
  let value = $state(untrack(() => title));
  let dialog = $state<HTMLDialogElement>();
  let input = $state<HTMLInputElement>();
  $effect(() => {
    if (!dialog) return;
    try {
      const dispose = activateModalDialog(dialog, () => input);
      input?.select();
      return dispose;
    } catch (error) { reportError(error); oncancel(); }
  });
</script>

<dialog bind:this={dialog} class={modalBackdropClass}
  aria-labelledby={`${ids}-title`} oncancel={(event) => { event.preventDefault(); oncancel(); }}>
  <form class="w-[min(400px,calc(100vw-32px))] max-h-[calc(100vh-32px)] overflow-auto rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-md"
    onsubmit={(event) => { event.preventDefault(); if (!saving && value.trim()) onconfirm(value); }}>
    <h2 id={`${ids}-title`} class="text-sm font-semibold">Rename Session</h2>
    <label for={`${ids}-name`} class="mt-3 block text-xs text-muted-foreground">Session name</label>
    <input bind:this={input} id={`${ids}-name`} bind:value disabled={saving} required
      class="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm" autocomplete="off" />
    <div class="mt-4 flex justify-end gap-2">
      <button type="button" class={dialogCancelButtonClass} onclick={oncancel}>Cancel</button>
      <button type="submit" class={dialogPrimaryButtonClass} disabled={saving || !value.trim()}>{saving ? "Renaming…" : "Rename"}</button>
    </div>
  </form>
</dialog>
