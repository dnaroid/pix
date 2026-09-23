<script lang="ts">
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import Brain from "@lucide/svelte/icons/brain";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import CopyIcon from "@lucide/svelte/icons/copy";
  import EllipsisVertical from "@lucide/svelte/icons/ellipsis-vertical";
  import GitFork from "@lucide/svelte/icons/git-fork";
  import PanelTopOpen from "@lucide/svelte/icons/panel-top-open";
  import Undo2 from "@lucide/svelte/icons/undo-2";
  import { onDestroy, tick } from "svelte";
  import type { Attachment } from "../lib/attachments";
  import type { ProjectFileLineRange } from "../lib/project-files";
  import {
    formatTranscriptDuration,
    groupTranscriptItems,
    type MessageItem,
    type TranscriptDisplayItem,
    type TranscriptState,
  } from "../lib/transcript";
  import AttachmentGrid from "./AttachmentGrid.svelte";
  import MarkdownText from "./MarkdownText.svelte";
  import TranscriptActivityGroup from "./TranscriptActivityGroup.svelte";
  import {
    createTranscriptUserMessageMenuController,
    userMessageMenuCommands,
    type UserMessageAction,
  } from "./transcript-user-message-menu-controller.svelte";

  let {
    transcript,
    activeSessionId,
    workspace,
    promptRunning,
    operationRunning,
    historyLoading,
    pane = $bindable(null),
    content = $bindable(null),
    showScrollToBottom,
    onScroll,
    onScrollToBottom,
    onLoadOlderHistory,
    onChooseWorkspace,
    onOpenAttachment,
    onPrepareAttachment,
    onValidateProjectFile,
    onValidateLocalFile,
    onOpenProjectFile,
    onResolveProjectMedia,
    onOpenLocalFile,
    onResolveLocalMedia,
    onLoadToolResult,
    onUserMessageAction,
  }: {
    transcript: TranscriptState;
    activeSessionId: string | null;
    workspace: string;
    promptRunning: boolean;
    operationRunning: boolean;
    historyLoading: boolean;
    pane?: HTMLDivElement | null;
    content?: HTMLDivElement | null;
    showScrollToBottom: boolean;
    onScroll: () => void;
    onScrollToBottom: () => void;
    onLoadOlderHistory: () => Promise<boolean>;
    onChooseWorkspace: () => void;
    onOpenAttachment: (attachment: Attachment) => void;
    onPrepareAttachment: (attachment: Attachment) => Promise<void>;
    onValidateProjectFile: (path: string) => Promise<boolean>;
    onValidateLocalFile: (path: string) => Promise<boolean>;
    onOpenProjectFile: (path: string, range?: ProjectFileLineRange) => void | Promise<void>;
    onResolveProjectMedia: (path: string) => Promise<Attachment | undefined>;
    onOpenLocalFile: (path: string) => void | Promise<void>;
    onResolveLocalMedia: (path: string) => Promise<Attachment | undefined>;
    onLoadToolResult: (toolCallId: string) => void;
    onUserMessageAction: (message: MessageItem, action: UserMessageAction) => void | Promise<void>;
  } = $props();

  let displayItems = $derived(groupTranscriptItems(transcript.items));
  let activityNowMs = $state(Date.now());
  const hasActiveActivity = $derived(displayItems.some((item) => item.type === "activity-group" && item.active));

  // One pane-level clock updates every live collapsed header. Completed rows
  // receive no clock prop, so their persisted final duration stays static.
  $effect(() => {
    if (!hasActiveActivity) return;
    activityNowMs = Date.now();
    const timer = window.setInterval(() => activityNowMs = Date.now(), 100);
    return () => window.clearInterval(timer);
  });

  const userMessageMenuController = createTranscriptUserMessageMenuController({
    items: () => displayItems,
    activeSessionId: () => activeSessionId,
    promptRunning: () => promptRunning,
    operationRunning: () => operationRunning,
    historyLoading: () => historyLoading,
    onScroll: () => onScroll(),
    onAction: (message, action) => onUserMessageAction(message, action),
  });
  const userMessageMenuState = userMessageMenuController.state;
  const copyMessageCommand = userMessageMenuCommands.copy;
  const forkMessageCommand = userMessageMenuCommands.fork;
  const forkNewTabCommand = userMessageMenuCommands.forkNewTab;
  const undoMessageCommand = userMessageMenuCommands.undo;
  const activeUserMessageMenu = $derived(userMessageMenuState.activeId);
  const userMessageMenuPosition = $derived(userMessageMenuState.position);
  const canMutateUserMessages = $derived(userMessageMenuController.canMutate);
  const activeUserMessage = $derived(userMessageMenuController.activeMessage);

  onDestroy(userMessageMenuController.dispose);

  function isServiceItem(item: TranscriptDisplayItem | undefined): boolean {
    return item?.type === "activity-group"
      || (item?.type === "message" && (item.role === "thought" || item.role === "system"));
  }

  function transcriptGapClass(
    item: TranscriptDisplayItem,
    next: TranscriptDisplayItem | undefined,
  ): string {
    if (isServiceItem(item) && isServiceItem(next)) return "mb-1";
    return isServiceItem(item) || isServiceItem(next) ? "mb-2" : "mb-6";
  }

  function durationLabel(startedAtMs: number | undefined, endedAtMs: number | undefined): string | undefined {
    if (startedAtMs === undefined || endedAtMs === undefined) return undefined;
    return formatTranscriptDuration(Math.max(0, endedAtMs - startedAtMs));
  }

  const handleUserMessageMenuKeydown = userMessageMenuController.handleMenuKeydown;
  const toggleUserMessageMenu = userMessageMenuController.toggle;
  const openUserMessageContextMenu = userMessageMenuController.openContextMenu;
  const handleWindowClick = userMessageMenuController.handleWindowClick;
  const handleWindowKeydown = userMessageMenuController.handleWindowKeydown;
  const handleWindowResize = userMessageMenuController.handleWindowResize;
  const handlePaneScroll = userMessageMenuController.handlePaneScroll;
  const runUserMessageAction = userMessageMenuController.runAction;

  const OLDER_HISTORY_THRESHOLD_PX = 96;
  let olderHistoryLoadPending = false;

  function viewportAnchor(): { id: string; top: number } | null {
    if (!pane) return null;
    const paneTop = pane.getBoundingClientRect().top;
    for (const entry of pane.querySelectorAll<HTMLElement>("[data-transcript-entry-id]")) {
      const rect = entry.getBoundingClientRect();
      if (rect.bottom < paneTop) continue;
      const id = entry.dataset.transcriptEntryId;
      if (id) return { id, top: rect.top };
    }
    return null;
  }

  async function loadOlderHistoryAtTop(): Promise<void> {
    if (!pane || olderHistoryLoadPending || pane.scrollTop > OLDER_HISTORY_THRESHOLD_PX) return;
    const requestSessionId = activeSessionId;
    if (!requestSessionId) return;

    olderHistoryLoadPending = true;
    const anchor = viewportAnchor();
    const previousScrollHeight = pane.scrollHeight;
    const previousScrollTop = pane.scrollTop;
    let loadedOlderHistory = false;
    try {
      const loaded = await onLoadOlderHistory();
      if (!loaded || requestSessionId !== activeSessionId) return;
      loadedOlderHistory = true;
      await tick();
      if (!pane || requestSessionId !== activeSessionId) return;

      const anchorTarget = anchor
        ? pane.querySelector<HTMLElement>(`[data-transcript-entry-id="${CSS.escape(anchor.id)}"]`)
        : null;
      if (anchorTarget && anchor) {
        pane.scrollTop += anchorTarget.getBoundingClientRect().top - anchor.top;
      } else {
        pane.scrollTop = previousScrollTop + Math.max(0, pane.scrollHeight - previousScrollHeight);
      }
    } finally {
      olderHistoryLoadPending = false;
      if (
        loadedOlderHistory
        && pane
        && requestSessionId === activeSessionId
        && pane.scrollTop <= OLDER_HISTORY_THRESHOLD_PX
      ) {
        void tick().then(() => loadOlderHistoryAtTop());
      }
    }
  }

  function handleTranscriptPaneScroll(): void {
    handlePaneScroll();
    void loadOlderHistoryAtTop();
  }

  $effect(() => {
    const sessionId = activeSessionId;
    const itemCount = transcript.items.length;
    const loading = historyLoading;
    if (!sessionId || loading || itemCount === 0) return;
    void tick().then(() => loadOlderHistoryAtTop());
  });
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleWindowKeydown} onresize={handleWindowResize} />

<div class="relative row-start-2 min-h-0 min-w-0">
  <div class="transcript-pane h-full min-h-0 overflow-auto" bind:this={pane} aria-live="polite" onscroll={handleTranscriptPaneScroll}>
  {#if !activeSessionId && !workspace}
    <section class="grid h-full place-items-center content-center p-10 text-center">
      <div class="mb-[18px] grid h-11 w-11 place-items-center rounded-md border border-border bg-panel-strong font-semibold text-primary">P</div>
      <h2 class="mb-2 text-lg font-medium text-foreground">Open a workspace</h2>
      <p class="mb-5 max-w-[470px] text-sm leading-relaxed text-muted-foreground">
        Choose a folder to begin a Pix session.
      </p>
      <button
        class="rounded-md border border-border bg-panel-strong px-3.5 py-2 text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
        onclick={onChooseWorkspace}
        disabled={promptRunning || operationRunning}
      >Choose workspace</button>
    </section>
  {:else if activeSessionId && transcript.items.length === 0 && historyLoading}
    <section class="grid min-h-[220px] place-items-center content-center p-10 text-center">
      <p class="text-sm text-muted-foreground" role="status">Loading conversation…</p>
    </section>
  {:else if transcript.items.length === 0}
    <section class="grid min-h-[220px] place-items-center content-center p-10 text-center">
      <h2 class="mb-2 text-lg font-medium text-foreground">What should we work on?</h2>
      <p class="mb-5 max-w-[470px] text-sm leading-relaxed text-muted-foreground">
        Pix can inspect this workspace, edit files, and run your development tools.
      </p>
    </section>
  {:else}
    <div class="w-full px-6 pt-[22px] pb-8 max-[760px]:px-3" bind:this={content}>
      {#each displayItems as item, index (item.id)}
        {@const gapClass = transcriptGapClass(item, displayItems[index + 1])}
        {#if item.type === "message"}
          {#if item.role === "thought"}
            {@const thoughtDuration = durationLabel(item.startedAtMs, item.endedAtMs)}
            <details class={["transcript-entry group w-full min-w-0 text-xs text-muted-foreground", gapClass]} data-transcript-entry-id={item.id}>
              <summary class="grid min-h-4 cursor-pointer list-none grid-cols-[14px_12px_minmax(0,1fr)] items-center gap-x-1.5 leading-tight text-muted-foreground/80 transition-colors select-none hover:text-foreground group-open:mb-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
                <Brain class="h-3 w-3 shrink-0 text-primary/65" aria-hidden="true" />
                <span class="flex min-w-0 items-baseline gap-x-1.5 overflow-hidden">
                  <span class="truncate">thinking</span>
                  {#if thoughtDuration}<span class="shrink-0 text-muted-foreground/45">{thoughtDuration}</span>{/if}
                </span>
              </summary>
              <div class="ml-[7px] border-l border-code-border pl-2.5 text-muted-foreground">
                <MarkdownText text={item.text} compact dense fitTables {onValidateProjectFile} {onValidateLocalFile} {onOpenProjectFile} {onResolveProjectMedia} {onOpenLocalFile} {onResolveLocalMedia} />
              </div>
            </details>
          {:else if item.role === "user"}
            <div
              class={["transcript-entry group/user-message relative", gapClass]}
              data-transcript-entry-id={item.id}
            >
              <article
                class="w-full rounded-md border border-chat-user-border bg-chat-user px-3.5 pt-3 pb-2 text-foreground"
                oncontextmenu={(event) => openUserMessageContextMenu(event, item.id)}
              >
                <AttachmentGrid attachments={item.attachments} onOpen={onOpenAttachment} onPrepare={onPrepareAttachment} />
                {#if item.text}<MarkdownText text={item.text} dense fitTables {onValidateProjectFile} {onValidateLocalFile} {onOpenProjectFile} {onResolveProjectMedia} {onOpenLocalFile} {onResolveLocalMedia} />{/if}
              </article>
              <button
                type="button"
                class="absolute top-2 right-2 grid h-7 w-7 place-items-center rounded-md border border-border/70 bg-panel-strong/95 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:bg-panel-hover hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover/user-message:opacity-100"
                aria-label="Message actions"
                aria-haspopup="menu"
                aria-expanded={activeUserMessageMenu === item.id}
                onclick={(event) => toggleUserMessageMenu(event, item.id)}
              >
                <EllipsisVertical class="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          {:else if item.role === "system"}
            <article class={["transcript-entry w-full min-w-0 font-mono text-xs text-muted-foreground", gapClass]} data-transcript-entry-id={item.id}>
              <AttachmentGrid attachments={item.attachments} onOpen={onOpenAttachment} onPrepare={onPrepareAttachment} />
              {#if item.text}<MarkdownText text={item.text} compact dense fitTables {onValidateProjectFile} {onValidateLocalFile} {onOpenProjectFile} {onResolveProjectMedia} {onOpenLocalFile} {onResolveLocalMedia} />{/if}
            </article>
          {:else}
            <article class={["transcript-entry w-full min-w-0 text-foreground", gapClass]} data-transcript-entry-id={item.id}>
              <AttachmentGrid attachments={item.attachments} onOpen={onOpenAttachment} onPrepare={onPrepareAttachment} />
              {#if item.text}<MarkdownText text={item.text} dense fitTables {onValidateProjectFile} {onValidateLocalFile} {onOpenProjectFile} {onResolveProjectMedia} {onOpenLocalFile} {onResolveLocalMedia} />{/if}
            </article>
          {/if}
        {:else}
          {#key activeSessionId}
            <TranscriptActivityGroup
              {item} nowMs={item.active ? activityNowMs : undefined} {gapClass} {onLoadToolResult} {onOpenAttachment} {onPrepareAttachment}
              {onValidateProjectFile} {onValidateLocalFile} {onOpenProjectFile}
              {onResolveProjectMedia} {onOpenLocalFile} {onResolveLocalMedia}
            />
          {/key}
        {/if}
      {/each}
    </div>
    {/if}
  </div>
  {#if activeSessionId && showScrollToBottom}
    <button
      type="button"
      class="absolute bottom-4 left-1/2 z-20 grid h-8 w-8 -translate-x-1/2 place-items-center rounded-md border border-border/70 bg-panel-strong/70 text-foreground shadow-xs backdrop-blur-sm transition-colors hover:bg-panel-hover/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      aria-label="Jump to latest message"
      title="Jump to latest message"
      onclick={onScrollToBottom}
    >
      <ArrowDown class="h-4 w-4" aria-hidden="true" />
    </button>
  {/if}

  {#if activeUserMessage && userMessageMenuPosition}
    <div
      bind:this={userMessageMenuState.menuElement}
      class="fixed z-[100] max-h-[calc(100vh-1rem)] w-48 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
      style={`left: ${userMessageMenuPosition.left}px; top: ${userMessageMenuPosition.top}px;`}
      role="menu"
      tabindex="-1"
      aria-label="Message actions"
      data-user-message-menu
      onkeydown={handleUserMessageMenuKeydown}
    >
      <button class="message-action-item" type="button" role="menuitem" tabindex="-1" onclick={() => void runUserMessageAction(activeUserMessage, "copy")}>
        <CopyIcon class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{copyMessageCommand.label}</span>
      </button>
      <button class="message-action-item" type="button" role="menuitem" tabindex="-1" disabled={!canMutateUserMessages || activeUserMessage.localOnly} onclick={() => void runUserMessageAction(activeUserMessage, "fork")}>
        <GitFork class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{forkMessageCommand.label}</span>
      </button>
      <button class="message-action-item" type="button" role="menuitem" tabindex="-1" disabled={!canMutateUserMessages || activeUserMessage.localOnly} onclick={() => void runUserMessageAction(activeUserMessage, "fork-new-tab")}>
        <PanelTopOpen class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{forkNewTabCommand.label}</span>
      </button>
      <div class="my-1 h-px bg-border" role="separator"></div>
      <button
        class="message-action-item danger"
        type="button"
        role="menuitem"
        tabindex="-1"
        disabled={!canMutateUserMessages || activeUserMessage.localOnly}
        onclick={() => void runUserMessageAction(activeUserMessage, "undo")}
      >
        <Undo2 class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{undoMessageCommand.label}</span>
      </button>
    </div>
  {/if}
</div>

<style>
  .transcript-entry {
    content-visibility: auto;
    contain-intrinsic-size: auto 120px;
  }

  .message-action-item {
    display: flex;
    width: 100%;
    height: 2rem;
    cursor: pointer;
    align-items: center;
    gap: 0.5rem;
    border-radius: 0.125rem;
    padding: 0 0.5rem;
    text-align: left;
    font-size: 0.75rem;
    color: var(--foreground);
  }

  .message-action-item:hover { background: var(--accent); }
  .message-action-item.danger { color: var(--destructive); }
  .message-action-item.danger:hover { background: color-mix(in srgb, var(--destructive) 10%, transparent); }
  .message-action-item:disabled { cursor: default; opacity: 0.4; }

</style>
