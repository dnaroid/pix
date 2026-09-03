<script lang="ts">
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import Square from "@lucide/svelte/icons/square";
  import type { Attachment } from "../lib/attachments";
  import AttachmentGrid from "./AttachmentGrid.svelte";

  let {
    promptText = $bindable(""),
    attachments,
    activeSessionId,
    ready,
    promptRunning,
    dragActive,
    onSubmit,
    onCancel,
    onChooseAttachments,
    onPasteAttachments,
    onRemoveAttachment,
    onOpenAttachment,
  }: {
    promptText?: string;
    attachments: readonly Attachment[];
    activeSessionId: string | null;
    ready: boolean;
    promptRunning: boolean;
    dragActive: boolean;
    onSubmit: () => void | Promise<void>;
    onCancel: () => void | Promise<void>;
    onChooseAttachments: () => void | Promise<void>;
    onPasteAttachments: (files: readonly File[]) => void | Promise<void>;
    onRemoveAttachment: (id: string) => void;
    onOpenAttachment: (attachment: Attachment) => void;
  } = $props();

  let composerForm: HTMLFormElement | undefined;
  let textarea: HTMLTextAreaElement | undefined;

  function resizeComposer(): void {
    if (!textarea) return;

    textarea.style.height = "auto";
    const composerChromeHeight = composerForm ? composerForm.offsetHeight - textarea.offsetHeight : 0;
    const maxTextareaHeight = Math.max(24, window.innerHeight / 2 - composerChromeHeight);
    const height = Math.min(textarea.scrollHeight, maxTextareaHeight);

    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxTextareaHeight ? "auto" : "hidden";
  }

  $effect(() => {
    promptText;
    promptRunning;
    attachments.length;
    const frame = requestAnimationFrame(resizeComposer);
    return () => cancelAnimationFrame(frame);
  });

  function handleSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void onSubmit();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void onSubmit();
  }

  function handlePaste(event: ClipboardEvent): void {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    void onPasteAttachments(files);
  }
</script>

<svelte:window onresize={resizeComposer} />

<form
  class={[
    "row-start-3 mx-2 mb-2 rounded-xl border bg-background px-3 pt-2.5 pb-2 shadow-xs focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20",
    dragActive ? "border-ring ring-2 ring-ring/30" : "border-input",
  ]}
  bind:this={composerForm}
  onsubmit={handleSubmit}
>
  <AttachmentGrid
    {attachments}
    variant="composer"
    onOpen={onOpenAttachment}
    onRemove={onRemoveAttachment}
  />
  <div class="flex items-end gap-1 text-sm">
    <textarea
      class="block min-h-6 min-w-0 flex-1 resize-none overflow-y-hidden border-0 bg-transparent px-0.5 leading-relaxed text-foreground outline-none placeholder:text-muted-foreground placeholder:opacity-25 disabled:cursor-default disabled:opacity-40"
      bind:this={textarea}
      bind:value={promptText}
      oninput={resizeComposer}
      onkeydown={handleKeydown}
      onpaste={handlePaste}
      placeholder={activeSessionId ? "Ask Pix to change, explain, or investigate…" : "Start or load a conversation first"}
      disabled={!activeSessionId || !ready}
      rows="1"
    ></textarea>
    <button
      class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
      type="button"
      aria-label="Attach files"
      title="Attach files"
      disabled={!activeSessionId || !ready || promptRunning}
      onclick={() => void onChooseAttachments()}
    >
      <Paperclip class="h-4 w-4" aria-hidden="true" />
    </button>
    {#if promptRunning}
      <button
        class="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-border bg-transparent text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        type="button"
        aria-label="Stop response"
        title="Stop response"
        onclick={onCancel}
      >
        <Square class="h-3 w-3 fill-current" aria-hidden="true" />
      </button>
    {/if}
  </div>
</form>
