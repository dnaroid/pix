<script lang="ts">
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import Square from "@lucide/svelte/icons/square";
  import { tick } from "svelte";
  import type { Attachment } from "../lib/attachments";
  import {
    PromptAutocompleteController,
    type PromptAutocompleteState,
  } from "../lib/autocomplete";
  import AttachmentGrid from "./AttachmentGrid.svelte";

  let {
    promptText = $bindable(""),
    attachments,
    activeSessionId,
    ready,
    promptRunning,
    dragActive,
    autocompleteEnabled,
    autocompleteDebounceMs,
    onAutocomplete,
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
    autocompleteEnabled: boolean;
    autocompleteDebounceMs: number;
    onAutocomplete: (draft: string, signal: AbortSignal) => Promise<string>;
    onSubmit: () => void | Promise<void>;
    onCancel: () => void | Promise<void>;
    onChooseAttachments: () => void | Promise<void>;
    onPasteAttachments: (files: readonly File[]) => void | Promise<void>;
    onRemoveAttachment: (id: string) => void;
    onOpenAttachment: (attachment: Attachment) => void;
  } = $props();

  let composerForm: HTMLFormElement | undefined;
  let textarea: HTMLTextAreaElement | undefined;
  let ghostLayer = $state<HTMLDivElement | undefined>();
  let autocompleteSuggestion = $state("");
  let composing = $state(false);
  const autocompleteController = new PromptAutocompleteController({
    request: (draft, signal) => onAutocomplete(draft, signal),
    onSuggestion: (suggestion) => {
      autocompleteSuggestion = suggestion;
      requestAnimationFrame(syncGhostLayer);
    },
  });

  function autocompleteState(target = textarea): PromptAutocompleteState {
    const text = target?.value ?? promptText;
    return {
      contextKey: activeSessionId ?? "",
      text,
      selectionStart: target?.selectionStart ?? text.length,
      selectionEnd: target?.selectionEnd ?? text.length,
      hasAttachments: attachments.length > 0,
      enabled: autocompleteEnabled && ready && !!activeSessionId && !composing,
    };
  }

  function observeAutocomplete(target = textarea): void {
    autocompleteController.observe(autocompleteState(target));
  }

  function syncGhostLayer(): void {
    if (!textarea || !ghostLayer) return;
    ghostLayer.style.paddingRight = `${Math.max(2, textarea.offsetWidth - textarea.clientWidth + 2)}px`;
    ghostLayer.scrollTop = textarea.scrollTop;
  }

  function resizeComposer(): void {
    if (!textarea) return;

    textarea.style.height = "auto";
    const composerChromeHeight = composerForm ? composerForm.offsetHeight - textarea.offsetHeight : 0;
    const maxTextareaHeight = Math.max(24, window.innerHeight / 2 - composerChromeHeight);
    const height = Math.min(textarea.scrollHeight, maxTextareaHeight);

    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxTextareaHeight ? "auto" : "hidden";
    syncGhostLayer();
  }

  $effect(() => {
    promptText;
    promptRunning;
    attachments.length;
    activeSessionId;
    ready;
    autocompleteEnabled;
    autocompleteController.setDebounceMs(autocompleteDebounceMs);
    observeAutocomplete();
    const frame = requestAnimationFrame(resizeComposer);
    return () => cancelAnimationFrame(frame);
  });

  $effect(() => () => autocompleteController.dispose());

  function handleSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void onSubmit();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (
      event.key === "Tab"
      && !event.shiftKey
      && !event.ctrlKey
      && !event.altKey
      && !event.metaKey
      && !event.isComposing
    ) {
      const accepted = autocompleteController.accept(autocompleteState(event.currentTarget as HTMLTextAreaElement));
      if (accepted !== undefined) {
        event.preventDefault();
        promptText = accepted;
        void tick().then(() => {
          textarea?.setSelectionRange(accepted.length, accepted.length);
          resizeComposer();
          observeAutocomplete();
        });
      }
      return;
    }
    if (event.key === "Escape" && autocompleteSuggestion) {
      event.preventDefault();
      autocompleteController.dismiss();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void onSubmit();
  }

  function handleInput(event: Event): void {
    resizeComposer();
    observeAutocomplete(event.currentTarget as HTMLTextAreaElement);
  }

  function handleKeyup(event: KeyboardEvent): void {
    if (event.key === "Tab" || event.key === "Escape") return;
    observeAutocomplete(event.currentTarget as HTMLTextAreaElement);
  }

  function handleScroll(event: Event): void {
    if (ghostLayer) ghostLayer.scrollTop = (event.currentTarget as HTMLTextAreaElement).scrollTop;
  }

  function handleCompositionStart(): void {
    composing = true;
    observeAutocomplete();
  }

  function handleCompositionEnd(event: CompositionEvent): void {
    composing = false;
    observeAutocomplete(event.currentTarget as HTMLTextAreaElement);
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
    <div class="relative min-w-0 flex-1">
      {#if autocompleteSuggestion}
        <div
          class="pointer-events-none absolute inset-0 overflow-hidden px-0.5 leading-relaxed whitespace-pre-wrap break-words"
          bind:this={ghostLayer}
          aria-hidden="true"
        ><span class="text-transparent">{promptText}</span><span class="text-muted-foreground/45">{autocompleteSuggestion}</span></div>
      {/if}
      <textarea
        class="relative z-10 block min-h-6 w-full resize-none overflow-y-hidden border-0 bg-transparent px-0.5 leading-relaxed text-foreground outline-none placeholder:text-muted-foreground placeholder:opacity-25 disabled:cursor-default disabled:opacity-40"
        bind:this={textarea}
        bind:value={promptText}
        oninput={handleInput}
        onkeydown={handleKeydown}
        onkeyup={handleKeyup}
        onselect={(event) => observeAutocomplete(event.currentTarget as HTMLTextAreaElement)}
        onclick={(event) => observeAutocomplete(event.currentTarget as HTMLTextAreaElement)}
        onscroll={handleScroll}
        oncompositionstart={handleCompositionStart}
        oncompositionend={handleCompositionEnd}
        onpaste={handlePaste}
        aria-label="Message Pix"
        aria-describedby="prompt-autocomplete-status"
        placeholder={activeSessionId ? "Ask Pix to change, explain, or investigate…" : "Start or load a conversation first"}
        disabled={!activeSessionId || !ready}
        rows="1"
      ></textarea>
    </div>
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
  <p id="prompt-autocomplete-status" class="sr-only" aria-live="polite">
    {autocompleteSuggestion ? "Autocomplete available. Press Tab to accept or Escape to dismiss." : ""}
  </p>
</form>
