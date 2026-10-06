<script lang="ts">
  import { onDestroy, tick, untrack, type Snippet } from "svelte";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { isTauri } from "@tauri-apps/api/core";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import Copy from "@lucide/svelte/icons/copy";
  import Plus from "@lucide/svelte/icons/plus";
  import Square from "@lucide/svelte/icons/square";
  import X from "@lucide/svelte/icons/x";
  import MarkdownText from "./MarkdownText.svelte";
  import type { BtwPaneState } from "../app/btw.svelte";
  import { BTW_DEFAULT_WIDTH, btwPaneWidthFromKeyboard, clampBtwPaneWidth } from "../lib/btw-pane-resize";

  let {
    state: chat, modelControl, ready = true,
    width = BTW_DEFAULT_WIDTH, availableWidth = 1200, scrollTop = 0,
    onWidthChange, onScroll, onDraftChange, onSend, onStop,
    onClose, onNewConversation, onAddSelectedText, onRemoveExcerpt, onInsertAnswer,
  }: {
    state: BtwPaneState;
    modelControl: Snippet;
    ready?: boolean;
    width?: number;
    availableWidth?: number;
    scrollTop?: number;
    onWidthChange: (width: number) => void;
    onScroll: (top: number) => void;
    onDraftChange: (draft: string) => void;
    onSend: () => void | Promise<void>;
    onStop: () => void | Promise<void>;
    onClose: () => void;
    onNewConversation: () => void;
    onAddSelectedText: () => void;
    onRemoveExcerpt: (index: number) => void;
    onInsertAnswer: (text: string) => boolean;
  } = $props();

  let textarea = $state<HTMLTextAreaElement | null>(null);
  let transcript = $state<HTMLDivElement | null>(null);
  let followsLatest = $state(true);
  let actionStatus = $state("");
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  let removeDrag: (() => void) | undefined;
  let disposed = false;
  let restoredScroll = false;
  const visibleWidth = $derived(clampBtwPaneWidth(width, availableWidth));
  const canSend = $derived(ready && !!chat.draft.trim() && !chat.busyRequestId && !chat.preparing);
  const live = $derived(chat.phase === "streaming" || chat.preparing);

  export function focus(): void { textarea?.focus(); }

  $effect(() => {
    const pane = transcript;
    if (!pane || restoredScroll) return;
    restoredScroll = true;
    untrack(() => {
      pane.scrollTop = scrollTop;
      followsLatest = !chat.history.length || pane.scrollHeight - pane.clientHeight - pane.scrollTop < 40;
    });
  });
  $effect(() => {
    chat.answer; chat.history; chat.pendingQuestion;
    if (!followsLatest) return;
    void tick().then(() => {
      if (!disposed && transcript) { transcript.scrollTop = transcript.scrollHeight; onScroll(transcript.scrollTop); }
    });
  });

  function trackScroll(): void {
    if (!transcript) return;
    followsLatest = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop < 40;
    onScroll(transcript.scrollTop);
  }

  function startResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault(); removeDrag?.();
    const start = event.clientX;
    const startWidth = visibleWidth;
    function move(event: PointerEvent): void { onWidthChange(clampBtwPaneWidth(startWidth + start - event.clientX, availableWidth)); }
    function finish(): void {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      removeDrag = undefined;
    }
    removeDrag = finish;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
    window.addEventListener("blur", finish, { once: true });
  }

  function resizeKeydown(event: KeyboardEvent): void {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    onWidthChange(btwPaneWidthFromKeyboard(width, event.key, availableWidth));
  }

  function paneKeydown(event: KeyboardEvent): void {
    // The shared model popup owns its keys; Escape must not close BTW too.
    if (event.target instanceof Element && event.target.closest("[data-model-thinking-popover]")) return;
    if (event.key === "Escape") {
      // Let an inner model picker handle Escape first; never bubble to parent's Stop.
      if (!event.defaultPrevented) { event.preventDefault(); onClose(); }
      event.stopPropagation();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault(); event.stopPropagation();
      if (canSend) void onSend();
    }
  }

  function inputKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault(); event.stopPropagation();
    if (canSend) { followsLatest = true; void onSend(); }
  }

  function status(text: string): void {
    actionStatus = text;
    if (copiedTimer !== undefined) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => actionStatus = "", 2500);
  }

  async function copy(text: string): Promise<void> {
    try {
      if (isTauri()) await writeText(text); else await navigator.clipboard.writeText(text);
      if (!disposed) status("Copied");
    } catch { if (!disposed) status("Could not copy this answer"); }
  }

  function insert(text: string): void {
    status(onInsertAnswer(text) ? "Inserted as a draft; not sent" : "Use an empty main composer with no attachments to insert");
  }

  onDestroy(() => {
    disposed = true; removeDrag?.();
    if (copiedTimer !== undefined) clearTimeout(copiedTimer);
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Delegates only pane-local shortcuts from focused descendants.) -->
<aside class="relative flex min-h-0 min-w-0 shrink-0 flex-col border-l border-border bg-background text-foreground"
  style:width={`${visibleWidth}px`} aria-label="BTW side chat" data-btw-pane onkeydown={paneKeydown}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions (A focusable ARIA window splitter supports arrow/Home/End resizing.) -->
  <div class="absolute inset-y-0 -left-1 z-10 w-2 cursor-ew-resize focus-visible:bg-primary/30 focus-visible:outline-none"
    role="separator" tabindex="0" aria-label="Resize BTW pane" aria-orientation="vertical"
    aria-valuemin={Math.min(300, visibleWidth)} aria-valuemax={clampBtwPaneWidth(640, availableWidth)} aria-valuenow={visibleWidth}
    onpointerdown={startResize} onkeydown={resizeKeydown}></div>
  <header class="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-chrome px-3">
    <strong class="text-xs font-semibold">BTW</strong>
    <div class="min-w-0 flex-1">{@render modelControl()}</div>
    <button type="button" class="grid h-7 w-7 shrink-0 place-items-center rounded-sm hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-ring"
      aria-label="New BTW conversation" title="New conversation" onclick={() => { onNewConversation(); followsLatest = true; focus(); }}><Plus size={15} /></button>
    <button type="button" class="grid h-7 w-7 shrink-0 place-items-center rounded-sm hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-ring"
      aria-label="Close BTW pane" title="Hide side chat" onclick={onClose}><X size={15} /></button>
  </header>
  <div bind:this={transcript} class="select-text min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-3" onscroll={trackScroll} aria-label="BTW conversation">
    {#if chat.context?.truncated}<p class="mb-3 text-xs text-muted-foreground">Context shortened to fit.</p>{/if}
    {#if chat.historyReset}<p class="mb-3 text-xs text-muted-foreground" role="status">Parent context changed. Earlier side exchanges were cleared.</p>{/if}
    {#if chat.historyClipped}<p class="mb-3 text-xs text-muted-foreground">Older side exchanges were dropped to stay within the history budget.</p>{/if}
    {#if !chat.history.length && !chat.pendingQuestion && !chat.answer}
      <p class="text-sm leading-5 text-muted-foreground">Ask about the current task without interrupting it. Answers use completed parent context, not independent file or test verification.</p>
    {/if}
    {#each chat.history as message, index}
      <section class="mb-4 min-w-0" data-btw-message={message.role} aria-label={message.role === "user" ? "Your side question" : "BTW answer"}>
        <div class="mb-1 flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
          <span>{message.role === "user" ? "You" : "BTW"}</span>
          {#if message.role === "assistant"}
            <span class="flex shrink-0 items-center gap-1">
              <button type="button" class="rounded-sm px-1.5 py-0.5 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                aria-label={`Copy BTW answer ${index}`} onclick={() => void copy(message.text)}><Copy size={13} /></button>
              <button type="button" class="rounded-sm px-1.5 py-0.5 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                aria-label={`Insert BTW answer ${index} in main composer`} onclick={() => insert(message.text)}>Insert</button>
            </span>
          {/if}
        </div>
        {#if message.role === "user"}<p class="whitespace-pre-wrap break-words text-sm">{message.text}</p>
        {:else}<MarkdownText text={message.text} compact dense fitTables />{/if}
      </section>
    {/each}
    {#if chat.pendingQuestion}<section class="mb-4" data-btw-message="pending-user"><p class="mb-1 text-xs font-medium text-muted-foreground">You</p><p class="whitespace-pre-wrap break-words text-sm">{chat.pendingQuestion}</p></section>{/if}
    {#if chat.answer}<section class="mb-4" data-btw-message="answer"><p class="mb-1 text-xs text-muted-foreground">BTW · {live ? "Answering" : "Incomplete response"}</p><MarkdownText text={chat.answer} compact dense fitTables /></section>{/if}
    {#if live && !chat.answer}<p class="text-xs text-muted-foreground" role="status">{chat.preparing ? "Preparing context…" : "Answering…"}</p>{/if}
    {#if chat.error}<p class="text-xs text-destructive" role="alert">{chat.error}</p>{/if}
    {#if !ready}<p class="text-xs text-muted-foreground" role="status">Parent runtime is unavailable.</p>{/if}
  </div>
  <footer class="shrink-0 border-t border-border bg-background px-3 py-2">
    <div class="mb-2 flex flex-wrap items-center gap-1">
      <button type="button" class="inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        onpointerdown={(event) => event.preventDefault()} onclick={onAddSelectedText}><Plus size={13} />Add selected text</button>
      {#each chat.excerpts as excerpt, index}
        <span class="inline-flex max-w-full items-center gap-1 rounded-sm border border-border px-1.5 py-1 text-xs text-muted-foreground">
          <span class="truncate">{excerpt.label} · {excerpt.text.length} chars</span>
          <button type="button" class="shrink-0 rounded-sm hover:bg-accent" aria-label={`Remove excerpt ${index + 1}`} onclick={() => onRemoveExcerpt(index)}><X size={12} /></button>
        </span>
      {/each}
    </div>
    <textarea bind:this={textarea} class="min-h-20 w-full resize-y rounded-md border border-input bg-panel-strong px-2.5 py-2 text-sm leading-5 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="BTW question" placeholder="Ask a side question…" maxlength="8000" value={chat.draft}
      oninput={(event) => onDraftChange(event.currentTarget.value)} onkeydown={inputKeydown} rows="3"></textarea>
    <div class="mt-1 flex min-h-7 items-center justify-between gap-2">
      <span class="min-w-0 text-xs text-muted-foreground" role="status">{actionStatus || (chat.busyRequestId && !live ? "Waiting for cancelled request to release…" : "Enter to send · Shift+Enter for a new line")}</span>
      {#if live || chat.busyRequestId}
        <button type="button" class="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          aria-label="Stop BTW response" onclick={() => void onStop()}><Square size={12} />Stop</button>
      {:else}
        <button type="button" class="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary px-2 text-xs text-primary-foreground disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-ring"
          aria-label="Send BTW question" disabled={!canSend} onclick={() => { followsLatest = true; void onSend(); }}><ArrowUp size={14} />Send</button>
      {/if}
    </div>
  </footer>
</aside>
