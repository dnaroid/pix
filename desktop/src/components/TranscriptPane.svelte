<script lang="ts">
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import Brain from "@lucide/svelte/icons/brain";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import CopyIcon from "@lucide/svelte/icons/copy";
  import EllipsisVertical from "@lucide/svelte/icons/ellipsis-vertical";
  import GitFork from "@lucide/svelte/icons/git-fork";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import PanelTopOpen from "@lucide/svelte/icons/panel-top-open";
  import Undo2 from "@lucide/svelte/icons/undo-2";
  import { onDestroy, tick } from "svelte";
  import type { Attachment } from "../lib/attachments";
  import { desktopCommandDefinition } from "../lib/desktop-commands";
  import {
    isTypeaheadKey,
    menuFocusIndex,
    menuTypeaheadFocusIndex,
    type MenuNavigationItem,
  } from "../lib/keyboard-navigation";
  import type { ProjectFileLineRange } from "../lib/project-files";
  import { toolGroupPresentationNames, toolPresentation } from "../lib/tool-presentation";
  import { toolGroupAttention, toolLspAttention } from "../lib/tool-output";
  import {
    formatTranscriptDuration,
    groupTranscriptItems,
    type ToolItem,
    type MessageItem,
    type TranscriptDisplayItem,
    type TranscriptState,
  } from "../lib/transcript";
  import AttachmentGrid from "./AttachmentGrid.svelte";
  import MarkdownText from "./MarkdownText.svelte";
  import ToolResult from "./ToolResult.svelte";
  import ToolStatusIcon from "./ToolStatusIcon.svelte";

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

  const copyMessageCommand = desktopCommandDefinition("message.copy");
  const forkMessageCommand = desktopCommandDefinition("message.fork");
  const forkNewTabCommand = desktopCommandDefinition("message.forkNewTab");
  const undoMessageCommand = desktopCommandDefinition("message.undo");

  let displayItems = $derived(groupTranscriptItems(transcript.items));
  let activeUserMessageMenu = $state<string | null>(null);
  let userMessageMenuPosition = $state<{ left: number; top: number } | null>(null);
  let userMessageMenu = $state<HTMLDivElement | null>(null);
  let userMessageMenuTrigger: HTMLElement | null = null;
  let userMessageMenuTypeaheadQuery = "";
  let userMessageMenuTypeaheadTimer: number | null = null;
  let canMutateUserMessages = $derived(
    !!activeSessionId && !promptRunning && !operationRunning && !historyLoading,
  );
  let activeUserMessage = $derived.by<MessageItem | null>(() => {
    if (!activeUserMessageMenu) return null;
    const item = displayItems.find((candidate) => candidate.id === activeUserMessageMenu);
    return item?.type === "message" && item.role === "user" ? item : null;
  });

  type UserMessageAction = "copy" | "fork" | "fork-new-tab" | "undo";

  const USER_MESSAGE_MENU_WIDTH = 192;
  const USER_MESSAGE_MENU_HEIGHT = 164;
  const USER_MESSAGE_MENU_GAP = 6;
  const USER_MESSAGE_MENU_MARGIN = 8;

  onDestroy(() => {
    if (userMessageMenuTypeaheadTimer !== null) window.clearTimeout(userMessageMenuTypeaheadTimer);
  });

  function handleToolResultToggle(event: Event, tool: ToolItem): void {
    const details = event.currentTarget as HTMLDetailsElement;
    if (details.open && tool.deferredResult && !tool.resultLoading) onLoadToolResult(tool.toolCallId);
  }

  function handleToolGroupToggle(event: Event, tools: readonly ToolItem[]): void {
    const details = event.currentTarget as HTMLDetailsElement;
    if (!details.open) return;
    for (const tool of tools) {
      if (tool.deferredResult && !tool.resultLoading) onLoadToolResult(tool.toolCallId);
    }
  }

  function isServiceItem(item: TranscriptDisplayItem | undefined): boolean {
    return item?.type === "tool-group"
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

  function toolGroupNames(tools: readonly ToolItem[]): string {
    return toolGroupPresentationNames(tools);
  }

  function closeUserMessageMenu(restoreFocus = false): void {
    activeUserMessageMenu = null;
    userMessageMenuPosition = null;
    if (restoreFocus) userMessageMenuTrigger?.focus();
    userMessageMenuTrigger = null;
  }

  function userMessageMenuItems(): MenuNavigationItem[] {
    const mutationDisabled = !canMutateUserMessages || !!activeUserMessage?.localOnly;
    return [
      { label: copyMessageCommand.label },
      { label: forkMessageCommand.label, disabled: mutationDisabled },
      { label: forkNewTabCommand.label, disabled: mutationDisabled },
      { label: undoMessageCommand.label, disabled: mutationDisabled },
    ];
  }

  function userMessageMenuButtons(): HTMLButtonElement[] {
    return [...(userMessageMenu?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [])];
  }

  function focusUserMessageMenuItem(index: number): void {
    userMessageMenuButtons()[index]?.focus();
  }

  function focusFirstUserMessageMenuItem(): void {
    void tick().then(() => {
      const firstIndex = menuFocusIndex(userMessageMenuItems(), -1, "ArrowDown");
      if (firstIndex !== null) focusUserMessageMenuItem(firstIndex);
    });
  }

  function handleUserMessageMenuKeydown(event: KeyboardEvent): void {
    const buttons = userMessageMenuButtons();
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[role='menuitem']")
      : null;
    const currentIndex = target ? buttons.indexOf(target) : -1;
    const items = userMessageMenuItems();

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeUserMessageMenu(true);
      return;
    }
    if (event.key === "Tab") {
      closeUserMessageMenu();
      return;
    }

    const nextIndex = menuFocusIndex(items, currentIndex, event.key);
    if (nextIndex !== null) {
      event.preventDefault();
      focusUserMessageMenuItem(nextIndex);
      return;
    }
    if (!isTypeaheadKey(event)) return;
    event.preventDefault();
    const key = event.key.toLocaleLowerCase();
    let query = userMessageMenuTypeaheadQuery.length === 1 && userMessageMenuTypeaheadQuery === key
      ? key
      : `${userMessageMenuTypeaheadQuery}${key}`;
    let typeaheadIndex = menuTypeaheadFocusIndex(items, currentIndex, query);
    if (typeaheadIndex === null && query.length > 1) {
      query = key;
      typeaheadIndex = menuTypeaheadFocusIndex(items, currentIndex, query);
    }
    userMessageMenuTypeaheadQuery = query;
    if (userMessageMenuTypeaheadTimer !== null) window.clearTimeout(userMessageMenuTypeaheadTimer);
    userMessageMenuTypeaheadTimer = window.setTimeout(() => {
      userMessageMenuTypeaheadQuery = "";
      userMessageMenuTypeaheadTimer = null;
    }, 700);
    if (typeaheadIndex !== null) focusUserMessageMenuItem(typeaheadIndex);
  }

  function clampMenuCoordinate(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  function positionUserMessageMenu(
    anchorX: number,
    anchorTop: number,
    anchorBottom: number,
    alignRight: boolean,
  ): void {
    const maxLeft = window.innerWidth - USER_MESSAGE_MENU_WIDTH - USER_MESSAGE_MENU_MARGIN;
    const left = clampMenuCoordinate(
      alignRight ? anchorX - USER_MESSAGE_MENU_WIDTH : anchorX,
      USER_MESSAGE_MENU_MARGIN,
      maxLeft,
    );
    const belowTop = anchorBottom + USER_MESSAGE_MENU_GAP;
    const aboveTop = anchorTop - USER_MESSAGE_MENU_GAP - USER_MESSAGE_MENU_HEIGHT;
    const top = belowTop + USER_MESSAGE_MENU_HEIGHT <= window.innerHeight - USER_MESSAGE_MENU_MARGIN
      ? belowTop
      : Math.max(USER_MESSAGE_MENU_MARGIN, aboveTop);
    userMessageMenuPosition = { left, top };
  }

  function toggleUserMessageMenu(event: MouseEvent, messageId: string): void {
    event.preventDefault();
    event.stopPropagation();
    if (activeUserMessageMenu === messageId) {
      closeUserMessageMenu();
      return;
    }
    const trigger = event.currentTarget as HTMLElement;
    const rect = trigger.getBoundingClientRect();
    userMessageMenuTrigger = trigger;
    activeUserMessageMenu = messageId;
    positionUserMessageMenu(rect.right, rect.top, rect.bottom, true);
    focusFirstUserMessageMenuItem();
  }

  function openUserMessageContextMenu(event: MouseEvent, messageId: string): void {
    event.preventDefault();
    event.stopPropagation();
    userMessageMenuTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    activeUserMessageMenu = messageId;
    positionUserMessageMenu(event.clientX, event.clientY, event.clientY, false);
    focusFirstUserMessageMenuItem();
  }

  function handleWindowClick(event: MouseEvent): void {
    if (!activeUserMessageMenu) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest("[data-user-message-menu]")) closeUserMessageMenu();
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !activeUserMessageMenu) return;
    event.preventDefault();
    closeUserMessageMenu(true);
  }

  function handleWindowResize(): void {
    if (activeUserMessageMenu) closeUserMessageMenu();
  }

  function handlePaneScroll(): void {
    if (activeUserMessageMenu) closeUserMessageMenu();
    onScroll();
  }

  async function runUserMessageAction(message: MessageItem, action: UserMessageAction): Promise<void> {
    if (action !== "copy" && !canMutateUserMessages) return;
    closeUserMessageMenu();
    await onUserMessageAction(message, action);
  }
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleWindowKeydown} onresize={handleWindowResize} />

<div class="relative row-start-2 min-h-0 min-w-0">
  <div class="transcript-pane h-full min-h-0 overflow-auto" bind:this={pane} aria-live="polite" onscroll={handlePaneScroll}>
  {#if !activeSessionId}
    <section class="grid h-full place-items-center content-center p-10 text-center">
      {#if workspace}
        <p class="text-[13px] text-muted-foreground" role="status">Opening conversation…</p>
      {:else}
        <div class="mb-[18px] grid h-11 w-11 place-items-center rounded-md border border-border bg-panel-strong font-semibold text-primary">P</div>
        <h2 class="mb-2 text-lg font-medium text-foreground">Open a workspace</h2>
        <p class="mb-5 max-w-[470px] text-[13px] leading-relaxed text-muted-foreground">
          Choose a folder to begin a Pix session.
        </p>
        <button
          class="rounded-md border border-border bg-panel-strong px-3.5 py-2 text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
          onclick={onChooseWorkspace}
          disabled={promptRunning || operationRunning}
        >Choose workspace</button>
      {/if}
    </section>
  {:else if transcript.items.length === 0 && historyLoading}
    <section class="grid min-h-[220px] place-items-center content-center p-10 text-center">
      <p class="text-[13px] text-muted-foreground" role="status">Loading conversation…</p>
    </section>
  {:else if transcript.items.length === 0}
    <section class="grid min-h-[220px] place-items-center content-center p-10 text-center">
      <h2 class="mb-2 text-lg font-medium text-foreground">What should we work on?</h2>
      <p class="mb-5 max-w-[470px] text-[13px] leading-relaxed text-muted-foreground">
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
          {@const groupAttention = toolGroupAttention(item.tools)}
          {@const groupNames = toolGroupNames(item.tools)}
          {@const groupDuration = item.durationMs === undefined ? undefined : formatTranscriptDuration(item.durationMs)}
          <details class={[
            "transcript-entry group w-full min-w-0 overflow-hidden bg-transparent text-muted-foreground/80",
            gapClass,
            item.status === "failed" && "text-destructive",
          ]} ontoggle={(event) => handleToolGroupToggle(event, item.tools)}>
            <summary class="grid min-h-4 cursor-pointer list-none grid-cols-[14px_12px_minmax(0,1fr)] items-center gap-x-1.5 overflow-hidden leading-tight transition-colors select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
              <ToolStatusIcon status={item.status} attention={groupAttention} class="h-3 w-3 opacity-75" />
              <span class="flex min-w-0 items-baseline gap-x-1.5 overflow-hidden text-xs">
                <strong class="min-w-0 truncate font-normal text-muted-foreground/85">{groupNames}</strong>
                {#if groupDuration}<span class="shrink-0 text-muted-foreground/45">{groupDuration}</span>{/if}
              </span>
            </summary>
            <div class="mt-1 ml-[7px] space-y-0.5 border-l border-code-border pl-2.5">
              {#each item.tools as tool (tool.id)}
                {@const presentation = toolPresentation(tool)}
                {@const attention = toolLspAttention(tool)}
                <section>
                  {#if tool.deferredResult || tool.content || tool.diffs.length > 0 || tool.attachments.length > 0}
                    <details class="group/result" ontoggle={(event) => handleToolResultToggle(event, tool)}>
                      <summary class="grid min-h-4 cursor-pointer list-none grid-cols-[14px_12px_minmax(0,1fr)] items-center gap-x-1.5 overflow-hidden leading-tight transition-colors select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                        <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform group-open/result:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
                        <ToolStatusIcon status={tool.status} {attention} class="h-3 w-3 opacity-80" />
                        <span class="flex min-w-0 items-baseline gap-x-1.5 overflow-hidden font-mono text-xs">
                          <strong class="tool-name shrink-0 font-bold" data-tool-tone={presentation.tone}>{presentation.name}</strong>
                          {#if presentation.args}<span class="min-w-0 truncate text-muted-foreground">{presentation.args}</span>{/if}
                        </span>
                      </summary>
                      {#if tool.resultLoading}
                        <div class="py-0.5 pl-8 text-xs leading-tight text-muted-foreground" role="status">Loading tool result…</div>
                      {:else if tool.resultError}
                        <div class="py-0.5 pl-8 text-xs leading-tight text-destructive" role="status">{tool.resultError}</div>
                      {/if}
                      <AttachmentGrid attachments={tool.attachments} variant="tool" onOpen={onOpenAttachment} onPrepare={onPrepareAttachment} />
                      {#if !tool.resultLoading && (tool.content || tool.diffs.length > 0)}
                        <ToolResult {tool} {onValidateProjectFile} {onValidateLocalFile} {onOpenProjectFile} {onResolveProjectMedia} {onOpenLocalFile} {onResolveLocalMedia} />
                      {/if}
                    </details>
                  {:else}
                    <div class="grid min-h-4 grid-cols-[14px_12px_minmax(0,1fr)] items-center gap-x-1.5 overflow-hidden leading-tight">
                      <span aria-hidden="true"></span>
                      <ToolStatusIcon status={tool.status} {attention} class="h-3 w-3 opacity-80" />
                      <span class="flex min-w-0 items-baseline gap-x-1.5 overflow-hidden font-mono text-xs">
                        <strong class="tool-name shrink-0 font-bold" data-tool-tone={presentation.tone}>{presentation.name}</strong>
                        {#if presentation.args}<span class="min-w-0 truncate text-muted-foreground">{presentation.args}</span>{/if}
                      </span>
                    </div>
                  {/if}
                </section>
              {/each}
            </div>
          </details>
        {/if}
      {/each}
      {#if promptRunning}
        <div class="flex min-h-5 items-center gap-1.5 py-0.5 text-xs text-muted-foreground" aria-label="Pix is working">
          <LoaderCircle class="h-3 w-3 animate-spin text-primary/75 motion-reduce:animate-none" aria-hidden="true" />
          <span>working</span>
        </div>
      {/if}
    </div>
    {/if}
  </div>
  {#if activeSessionId && showScrollToBottom}
    <button
      type="button"
      class="absolute bottom-4 left-1/2 z-20 grid h-8 w-8 -translate-x-1/2 place-items-center rounded-md border border-border bg-panel-strong text-foreground shadow-xs transition-colors hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      aria-label="Jump to latest message"
      title="Jump to latest message"
      onclick={onScrollToBottom}
    >
      <ArrowDown class="h-4 w-4" aria-hidden="true" />
    </button>
  {/if}

  {#if activeUserMessage && userMessageMenuPosition}
    <div
      bind:this={userMessageMenu}
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
  .message-action-item:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
  .message-action-item:disabled { cursor: default; opacity: 0.4; }

  .tool-name[data-tool-tone="accent"] { color: var(--tool-accent); }
  .tool-name[data-tool-tone="info"] { color: var(--tool-info); }
  .tool-name[data-tool-tone="muted"] { color: var(--tool-muted); }
  .tool-name[data-tool-tone="mutation"] { color: var(--tool-mutation); }
  .tool-name[data-tool-tone="search"] { color: var(--tool-search); }
  .tool-name[data-tool-tone="success"] { color: var(--tool-success); }
  .tool-name[data-tool-tone="title"] { color: var(--tool-title); }
  .tool-name[data-tool-tone="warning"] { color: var(--tool-warning); }
</style>
