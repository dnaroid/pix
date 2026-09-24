<script lang="ts">
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import { onDestroy, onMount, tick } from "svelte";
  import type { AvailableCommand } from "@agentclientprotocol/sdk";
  import type { Attachment } from "../lib/attachments";
  import type { AgentControlState } from "../lib/agent-control";
  import { desktopCommandDefinition } from "../lib/desktop-commands";
  import {
    isTypeaheadKey,
    menuFocusIndex,
    menuTypeaheadFocusIndex,
    type MenuNavigationItem,
  } from "../lib/keyboard-navigation";
  import type { QuestionComposerMode } from "../lib/question";
  import {
    insertPromptPaths,
    projectTreeDragPayloadFromUnknown,
    PROJECT_TREE_DRAG_STATE_EVENT,
    PROJECT_TREE_DROP_EVENT,
  } from "../lib/project-tree";
  import AttachmentGrid from "./AttachmentGrid.svelte";
  import PromptComposerActionsMenu from "./PromptComposerActionsMenu.svelte";
  import PromptComposerControls from "./PromptComposerControls.svelte";
  import PromptQuestionnairePanel from "./PromptQuestionnairePanel.svelte";
  import PromptSlashCommandMenu from "./PromptSlashCommandMenu.svelte";
  import { createPromptComposerQuestionnaireController } from "./prompt-composer-questionnaire-controller.svelte";
  import { createPromptComposerSlashController } from "./prompt-composer-slash-controller.svelte";
  import { createPromptComposerTextareaController } from "./prompt-composer-textarea-controller.svelte";
  import { createPromptComposerVoiceController } from "./prompt-composer-voice-controller.svelte";

  let {
    promptText = $bindable(""),
    attachments,
    variant = "prompt",
    placeholder,
    ariaLabel,
    availableCommands = [],
    activeSessionId,
    draftSession = false,
    ready,
    promptRunning,
    agentControlState = "idle",
    dragActive,
    autocompleteEnabled,
    autocompleteDebounceMs,
    questionMode,
    onAutocomplete,
    onDraftChange = () => {},
    onOpenHistory,
    onEnhance,
    onSubmit,
    onDefer,
    onCreateTask,
    onPause = () => {},
    onContinue = () => {},
    onCancel,
    onChooseAttachments,
    onPasteAttachments,
    onRemoveAttachment,
    onOpenAttachment,
  }: {
    promptText?: string;
    attachments: readonly Attachment[];
    variant?: "prompt" | "editor";
    placeholder?: string;
    ariaLabel?: string;
    availableCommands?: readonly AvailableCommand[];
    activeSessionId: string | null;
    draftSession?: boolean;
    ready: boolean;
    promptRunning: boolean;
    agentControlState?: AgentControlState;
    dragActive: boolean;
    autocompleteEnabled: boolean;
    autocompleteDebounceMs: number;
    questionMode?: QuestionComposerMode;
    onAutocomplete: (draft: string, signal: AbortSignal) => Promise<string>;
    onDraftChange?: () => void;
    onOpenHistory?: () => void | Promise<void>;
    onEnhance?: () => void | Promise<void>;
    onSubmit: () => void | Promise<void>;
    onDefer: () => void | Promise<void>;
    onCreateTask?: () => void | Promise<void>;
    onPause?: () => void | Promise<void>;
    onContinue?: () => void | Promise<void>;
    onCancel: () => void | Promise<void>;
    onChooseAttachments: () => void | Promise<void>;
    onPasteAttachments: (files: readonly File[]) => void | Promise<void>;
    onRemoveAttachment: (id: string) => void;
    onOpenAttachment: (attachment: Attachment) => void;
  } = $props();

  const historyCommand = desktopCommandDefinition("session.history");
  const enhanceCommand = desktopCommandDefinition("composer.enhance");
  const createTaskCommand = desktopCommandDefinition("composer.createTask");
  const deferCommand = desktopCommandDefinition("composer.defer");

  let composerForm = $state<HTMLFormElement | undefined>();
  let textarea = $state<HTMLTextAreaElement | undefined>();
  let ghostLayer = $state<HTMLDivElement | undefined>();
  let slashListbox = $state<HTMLDivElement | undefined>();
  let projectPathDragActive = $state(false);
  let composerMenuOpen = $state(false);
  let composerMenu = $state<HTMLDivElement | null>(null);
  let composerMenuTrigger = $state<HTMLButtonElement | null>(null);
  let composerMenuTypeaheadQuery = "";
  let composerMenuTypeaheadTimer: number | null = null;
  const textareaController = createPromptComposerTextareaController({
    textarea: () => textarea,
    ghostLayer: () => ghostLayer,
    composerForm: () => composerForm,
    promptText: () => promptText,
    setPromptText: (value) => {
      promptText = value;
      onDraftChange();
    },
    activeSessionId: () => activeSessionId,
    attachmentsCount: () => attachments.length,
    editorMode: () => editorMode,
    questionMode: () => !!questionMode,
    autocompleteEnabled: () => autocompleteEnabled,
    ready: () => ready,
    requestAutocomplete: (draft, signal) => onAutocomplete(draft, signal),
  });
  const voiceController = createPromptComposerVoiceController({
    contextKey: () => conversationContextKey,
    ready: () => ready,
    editorMode: () => editorMode,
    questionMode: () => !!questionMode,
    dismissAutocomplete: () => textareaController.dismiss(),
    insertTranscript: insertVoiceTranscript,
  });
  const slashController = createPromptComposerSlashController({
    promptText: () => promptText,
    selectionStart: () => textareaController.selectionStart,
    selectionEnd: () => textareaController.selectionEnd,
    availableCommands: () => availableCommands,
    editorMode: () => editorMode,
    ready: () => ready,
    activeSessionId: () => activeSessionId,
    promptRunning: () => promptRunning,
    questionMode: () => !!questionMode,
    composing: () => textareaController.composing,
    attachmentsCount: () => attachments.length,
    listbox: () => slashListbox,
    dismissAutocomplete: () => textareaController.dismiss(),
    closeComposerMenu: () => { composerMenuOpen = false; },
    replacePromptText: (value, cursor) => textareaController.replacePromptText(value, cursor),
    submit: () => onSubmit(),
  });
  const questionnaireController = createPromptComposerQuestionnaireController({
    mode: () => questionMode,
    form: () => composerForm,
    textarea: () => textarea,
    attachments: () => attachments,
    removeAttachment: (id) => onRemoveAttachment(id),
    openAttachment: (attachment) => onOpenAttachment(attachment),
  });

  onDestroy(() => {
    if (composerMenuTypeaheadTimer !== null) window.clearTimeout(composerMenuTypeaheadTimer);
  });

  const editorMode = $derived(variant === "editor" && !questionMode);
  const textareaValue = $derived(composerText());
  const conversationContextKey = $derived(activeSessionId ?? (draftSession ? "pix:desktop-draft-session" : undefined));
  const hasConversationTarget = $derived(!!conversationContextKey);
  const hasQueueableDraft = $derived(!questionMode && (promptText.trim().length > 0 || attachments.length > 0));
  const canSubmitPrompt = $derived(
    !editorMode
      && !questionMode
      && ready
      && hasConversationTarget
      && hasQueueableDraft
      && (!promptRunning || !promptText.trimStart().startsWith("/")),
  );
  const canOpenPromptHistory = $derived(
    !editorMode
      && !questionMode
      && !!onOpenHistory
      && !!activeSessionId
      && ready,
  );
  const canCreateTask = $derived(
    !editorMode
      && !questionMode
      && !!onCreateTask
      && !!activeSessionId
      && ready
      && (hasQueueableDraft || voiceController.state !== "idle"),
  );
  const canEnhancePrompt = $derived(
    !editorMode
      && !questionMode
      && !!onEnhance
      && !!activeSessionId
      && ready
      && !promptRunning
      && promptText.trim().length >= 3,
  );
  const promptAssistiveStatus = $derived.by(() => {
    if (slashController.open) {
      return `${slashController.matches.length} slash commands available. Use arrow keys to navigate, then Tab or Enter to choose.`;
    }
    if (!questionMode && textareaController.suggestion) {
      return "Autocomplete available. Press Tab to accept or Escape to dismiss.";
    }
    return "";
  });
  const slashListboxId = "prompt-slash-command-listbox";

  function composerText(): string {
    return questionnaireController.textValue(promptText);
  }

  function composerPlaceholder(): string {
    if (placeholder) return placeholder;
    if (questionMode) return "Type a custom answer or paste an image…";
    return hasConversationTarget
      ? "Ask Pix anything…"
      : "Start or load a conversation first";
  }

  /** Focus the normal prompt editor after an external action restores a draft. */
  export async function focus(): Promise<void> {
    await textareaController.focusPrompt();
  }

  /** Insert one or more filesystem paths as plain quoted text in the prompt. */
  export async function insertPaths(paths: readonly string[]): Promise<void> {
    if (questionMode || editorMode || !ready || !hasConversationTarget || paths.length === 0) return;
    const start = textarea?.selectionStart ?? textareaController.selectionStart;
    const end = textarea?.selectionEnd ?? textareaController.selectionEnd;
    const insertion = insertPromptPaths(promptText, start, end, paths);
    if (insertion.text === promptText) return;
    slashController.clearDismissal();
    await textareaController.replacePromptText(insertion.text, insertion.cursor);
  }

  $effect(() => {
    promptText;
    promptRunning;
    attachments.length;
    activeSessionId;
    draftSession;
    ready;
    autocompleteEnabled;
    questionMode?.state.activeTab;
    questionnaireController.currentDraft?.customText;
    questionnaireController.currentDraft?.images.length;
    questionnaireController.currentDraft?.choiceValues;
    questionnaireController.currentDraft?.customSelected;
    textareaController.setDebounceMs(autocompleteDebounceMs);
    textareaController.observe();
    const frame = requestAnimationFrame(textareaController.resize);
    return () => cancelAnimationFrame(frame);
  });

  $effect(() => () => textareaController.dispose());

  onMount(() => {
    const closeComposerMenuOutside = (event: PointerEvent) => {
      if (!composerMenuOpen) return;
      const target = event.target as HTMLElement | null;
      if (!target?.closest("[data-composer-menu]")) composerMenuOpen = false;
    };
    document.addEventListener("pointerdown", closeComposerMenuOutside);
    return () => document.removeEventListener("pointerdown", closeComposerMenuOutside);
  });

  $effect(() => {
    if (editorMode || questionMode || !hasConversationTarget || !ready) composerMenuOpen = false;
  });

  $effect(() => {
    const form = composerForm;
    if (!form) return;
    form.addEventListener(PROJECT_TREE_DRAG_STATE_EVENT, handleProjectTreeDragStateEvent);
    form.addEventListener(PROJECT_TREE_DROP_EVENT, handleProjectTreeDropEvent);
    return () => {
      form.removeEventListener(PROJECT_TREE_DRAG_STATE_EVENT, handleProjectTreeDragStateEvent);
      form.removeEventListener(PROJECT_TREE_DROP_EVENT, handleProjectTreeDropEvent);
    };
  });

  async function handleSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!questionnaireController.handleSubmit()) {
      await voiceController.stop();
      await onSubmit();
    }
  }

  async function deferWithVoiceStop(): Promise<void> {
    composerMenuOpen = false;
    if (!activeSessionId || !ready || !hasQueueableDraft) return;
    await voiceController.stop();
    await onDefer();
  }

  async function createTaskWithVoiceStop(): Promise<void> {
    composerMenuOpen = false;
    if (!canCreateTask || !onCreateTask) return;
    await voiceController.stop();
    await onCreateTask();
  }

  async function enhanceWithVoiceStop(): Promise<void> {
    composerMenuOpen = false;
    if (!canEnhancePrompt || !onEnhance) return;
    await voiceController.stop();
    if (promptText.trim().length < 3) return;
    await onEnhance();
    await focus();
  }

  async function openPromptHistory(): Promise<void> {
    composerMenuOpen = false;
    if (!canOpenPromptHistory || !onOpenHistory) return;
    await onOpenHistory();
  }

  function toggleComposerMenu(): void {
    if (composerMenuOpen) {
      composerMenuOpen = false;
      return;
    }
    composerMenuOpen = true;
    slashController.dismissCurrent();
    textareaController.dismiss();
    void tick().then(() => {
      const items = composerMenuNavigationItems();
      const firstIndex = menuFocusIndex(items, -1, "ArrowDown");
      if (firstIndex !== null) focusComposerMenuItem(firstIndex);
    });
  }

  function composerMenuNavigationItems(): MenuNavigationItem[] {
    return [
      { label: historyCommand.label, disabled: !canOpenPromptHistory },
      { label: enhanceCommand.label, disabled: !canEnhancePrompt },
      { label: createTaskCommand.label, disabled: !canCreateTask },
      { label: deferCommand.label, disabled: !activeSessionId || !ready || !hasQueueableDraft },
    ];
  }

  function composerMenuButtons(): HTMLButtonElement[] {
    return [...(composerMenu?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [])];
  }

  function focusComposerMenuItem(index: number): void {
    composerMenuButtons()[index]?.focus();
  }

  function handleComposerMenuKeydown(event: KeyboardEvent): void {
    const buttons = composerMenuButtons();
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[role='menuitem']")
      : null;
    const currentIndex = target ? buttons.indexOf(target) : -1;
    const items = composerMenuNavigationItems();

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      composerMenuOpen = false;
      composerMenuTrigger?.focus();
      return;
    }
    if (event.key === "Tab") {
      composerMenuOpen = false;
      return;
    }

    const nextIndex = menuFocusIndex(items, currentIndex, event.key);
    if (nextIndex !== null) {
      event.preventDefault();
      focusComposerMenuItem(nextIndex);
      return;
    }

    if (!isTypeaheadKey(event)) return;
    event.preventDefault();
    const key = event.key.toLocaleLowerCase();
    let query = composerMenuTypeaheadQuery.length === 1 && composerMenuTypeaheadQuery === key
      ? key
      : `${composerMenuTypeaheadQuery}${key}`;
    let typeaheadIndex = menuTypeaheadFocusIndex(items, currentIndex, query);
    if (typeaheadIndex === null && query.length > 1) {
      query = key;
      typeaheadIndex = menuTypeaheadFocusIndex(items, currentIndex, query);
    }
    composerMenuTypeaheadQuery = query;
    if (composerMenuTypeaheadTimer !== null) window.clearTimeout(composerMenuTypeaheadTimer);
    composerMenuTypeaheadTimer = window.setTimeout(() => {
      composerMenuTypeaheadQuery = "";
      composerMenuTypeaheadTimer = null;
    }, 700);
    if (typeaheadIndex !== null) focusComposerMenuItem(typeaheadIndex);
  }

  async function insertVoiceTranscript(rawText: string, sessionId: string | undefined): Promise<void> {
    if (editorMode || questionMode || !sessionId || sessionId !== conversationContextKey) return;
    const transcript = rawText.trim().replace(/\s+/gu, " ");
    if (!transcript) return;
    const start = textarea?.selectionStart ?? textareaController.selectionStart;
    const end = textarea?.selectionEnd ?? textareaController.selectionEnd;
    const before = promptText.slice(0, start);
    const after = promptText.slice(end);
    const prefix = before.length > 0 && !/\s$/u.test(before) ? " " : "";
    const suffix = after.length > 0 && !/^\s/u.test(after) ? " " : "";
    const insertion = `${prefix}${transcript}${suffix}`;
    const cursor = before.length + insertion.length;
    slashController.clearDismissal();
    await textareaController.replacePromptText(`${before}${insertion}${after}`, cursor);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (slashController.handleKeydown(event)) return;
    if (
      !editorMode
      && !questionMode
      && event.key === "Tab"
      && !event.shiftKey
      && !event.ctrlKey
      && !event.altKey
      && !event.metaKey
      && !event.isComposing
    ) {
      if (textareaController.acceptAutocomplete(event.currentTarget as HTMLTextAreaElement)) {
        event.preventDefault();
      }
      return;
    }
    if (!editorMode && !questionMode && event.key === "Escape" && textareaController.suggestion) {
      event.preventDefault();
      textareaController.dismiss();
      return;
    }
    if (editorMode) return;
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    composerForm?.requestSubmit();
  }

  function handleInput(event: Event): void {
    const target = event.currentTarget as HTMLTextAreaElement;
    const value = target.value;
    if (!questionnaireController.updateCustomText(value)) {
      promptText = value;
      onDraftChange();
    }
    textareaController.handleInput(target);
  }

  function handlePaste(event: ClipboardEvent): void {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    if (!questionnaireController.pasteImages(files) && !questionMode) {
      void onPasteAttachments(files);
    }
  }

  function canAcceptProjectTreeDrop(): boolean {
    return !editorMode
      && !questionMode
      && ready
      && !!activeSessionId;
  }

  function handleProjectTreeDragStateEvent(event: Event): void {
    const detail = (event as CustomEvent<unknown>).detail;
    const active = !!detail
      && typeof detail === "object"
      && !Array.isArray(detail)
      && (detail as Record<string, unknown>).active === true;
    projectPathDragActive = active && canAcceptProjectTreeDrop();
    if (projectPathDragActive) textareaController.dismiss();
  }

  function handleProjectTreeDropEvent(event: Event): void {
    projectPathDragActive = false;
    if (!canAcceptProjectTreeDrop()) return;
    const entry = projectTreeDragPayloadFromUnknown((event as CustomEvent<unknown>).detail);
    if (!entry) return;
    void insertPaths([entry.path]);
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (composerMenuOpen && event.key === "Escape" && !event.isComposing) {
      event.preventDefault();
      composerMenuOpen = false;
      composerMenuTrigger?.focus();
      return;
    }
    questionnaireController.handleEscape(event);
  }
</script>

<svelte:window onresize={textareaController.resize} onkeydown={handleWindowKeydown} />

<div class={editorMode ? "relative" : "relative border-t border-border bg-panel px-3 py-2"}>
{#if slashController.open}
  <PromptSlashCommandMenu
    matches={slashController.matches}
    selectedIndex={slashController.selectedIndex}
    bind:listbox={slashListbox}
    listboxId={slashListboxId}
    onSelectIndex={slashController.select}
    onChoose={(match) => void slashController.accept(match, false)}
  />
{/if}

{#if composerMenuOpen && !editorMode && !questionMode}
  <PromptComposerActionsMenu
    bind:menu={composerMenu}
    historyLabel={historyCommand.label}
    enhanceLabel={enhanceCommand.label}
    createTaskLabel={createTaskCommand.label}
    deferLabel={deferCommand.label}
    canOpenHistory={canOpenPromptHistory}
    canEnhance={canEnhancePrompt}
    {canCreateTask}
    canDefer={!!activeSessionId && ready && hasQueueableDraft}
    onOpenHistory={() => void openPromptHistory()}
    onEnhance={() => void enhanceWithVoiceStop()}
    onCreateTask={() => void createTaskWithVoiceStop()}
    onDefer={() => void deferWithVoiceStop()}
    onKeydown={handleComposerMenuKeydown}
  />
{/if}

<form
  class={[
    "overflow-hidden rounded-md border bg-panel-strong",
    dragActive || projectPathDragActive ? "border-ring ring-1 ring-ring/40" : "border-input",
  ]}
  bind:this={composerForm}
  data-pix-project-path-drop-target="true"
  onsubmit={handleSubmit}
>
  {#if questionMode}
    <PromptQuestionnairePanel
      {questionMode}
      requiresPreview={questionnaireController.requiresPreview}
      previewing={questionnaireController.previewing}
      allQuestionsComplete={questionnaireController.allQuestionsComplete}
      currentQuestion={questionnaireController.currentQuestion}
      currentDraft={questionnaireController.currentDraft}
      currentSelectionCount={questionnaireController.currentSelectionCount}
      selectedChoiceIndex={questionnaireController.selectedChoiceIndex()}
      answerLabel={questionnaireController.answerLabel}
      onSelectTab={questionnaireController.selectTab}
      onEditAnswer={questionnaireController.editAnswer}
      onChooseChoice={questionnaireController.chooseChoice}
      onChooseCustom={() => void questionnaireController.chooseCustom()}
      onTabKeydown={questionnaireController.handleTabKeydown}
      onChoiceKeydown={questionnaireController.handleChoiceKeydown}
    />
  {/if}

  <div class={questionMode ? "px-3 pt-2 pb-2" : editorMode ? "px-3 pt-2.5 pb-2" : "px-2 py-1.5"}>
    {#if !questionMode || questionnaireController.currentDraft?.customSelected}
      <AttachmentGrid
        attachments={questionnaireController.displayedAttachments}
        variant="composer"
        onOpen={questionnaireController.openDisplayedAttachment}
        onRemove={questionnaireController.removeDisplayedAttachment}
      />
      <div class="flex min-w-0 items-end gap-1.5" data-prompt-composer-row>
        <button
          class="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
          type="button"
          aria-label={questionMode ? "Attach images" : "Attach files"}
          title={questionMode ? "Attach images" : "Attach files"}
          disabled={questionMode ? questionMode.addingImages : editorMode ? !ready : !hasConversationTarget || !ready}
          onclick={() => {
            if (questionMode) questionnaireController.chooseImages();
            else void onChooseAttachments();
          }}
        >
          <Paperclip class="h-4 w-4" aria-hidden="true" />
        </button>
        <div class="relative min-w-0 flex-1 text-sm">
          {#if textareaController.suggestion && !editorMode && !questionMode}
            <div
              class="pointer-events-none absolute inset-0 overflow-hidden px-0.5 py-1 leading-5 whitespace-pre-wrap break-words"
              bind:this={ghostLayer}
              aria-hidden="true"
            ><span class="text-transparent">{promptText}</span><span class="text-muted-foreground/45">{textareaController.suggestion}</span></div>
          {/if}
          <textarea
            class="relative z-10 block min-h-7 w-full resize-none overflow-y-hidden border-0 bg-transparent px-0.5 py-1 leading-5 text-foreground outline-none placeholder:text-muted-foreground placeholder:opacity-40 [&::placeholder]:whitespace-nowrap disabled:cursor-default disabled:opacity-40"
            bind:this={textarea}
            value={textareaValue}
            oninput={handleInput}
            onkeydown={handleKeydown}
            onkeyup={textareaController.handleKeyup}
            onselect={textareaController.handleSelection}
            onclick={textareaController.handleSelection}
            onscroll={textareaController.handleScroll}
            oncompositionstart={textareaController.handleCompositionStart}
            oncompositionend={textareaController.handleCompositionEnd}
            onpaste={handlePaste}
            aria-label={ariaLabel ?? (questionMode ? `Custom answer for ${questionnaireController.currentQuestion?.label ?? "question"}` : editorMode ? "Editor" : "Message Pix")}
            aria-describedby="prompt-autocomplete-status"
            role={!editorMode && !questionMode ? "combobox" : undefined}
            aria-autocomplete={!editorMode && !questionMode ? "list" : undefined}
            aria-expanded={!editorMode && !questionMode ? slashController.open : undefined}
            aria-controls={!editorMode && !questionMode && slashController.open ? slashListboxId : undefined}
            aria-activedescendant={!editorMode && !questionMode && slashController.open ? `prompt-slash-command-${slashController.selectedIndex}` : undefined}
            placeholder={composerPlaceholder()}
            disabled={questionMode ? !questionnaireController.currentQuestion : editorMode ? !ready : !hasConversationTarget || !ready}
            rows="1"
          ></textarea>
        </div>
        {#if !editorMode && !questionMode}
          <div class="flex shrink-0 items-center gap-1">
            <PromptComposerControls
              bind:menuTrigger={composerMenuTrigger}
              menuOpen={composerMenuOpen}
              voiceState={voiceController.state}
              voiceSupported={voiceController.supported}
              voiceCanStart={voiceController.canStart}
              {promptRunning}
              {agentControlState}
              canSubmit={canSubmitPrompt}
              onToggleMenu={toggleComposerMenu}
              onToggleVoice={() => void voiceController.toggle()}
              {onPause}
              {onCancel}
              {onContinue}
            />
          </div>
        {/if}
      </div>
      {#if !editorMode && !questionMode && (voiceController.interim || voiceController.error)}
        <p
          class={[
            "mt-1.5 truncate text-xs",
            voiceController.error ? "text-destructive" : "text-muted-foreground",
          ]}
          aria-live="polite"
        >{voiceController.error || `Listening: ${voiceController.interim}`}</p>
      {/if}
    {/if}

    {#if questionMode}
      <div class="flex items-center justify-between gap-3 border-t border-border pt-2 {questionnaireController.currentDraft?.customSelected ? 'mt-2' : ''}">
        <button
          class="rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          type="button"
          onclick={questionMode.onCancel}
        >Cancel</button>
        {#if questionMode.addingImages}<span class="ml-auto text-xs text-muted-foreground" aria-live="polite">Adding images…</span>{/if}
        {#if questionnaireController.previewing}
          <button
            class="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
            type="submit"
            disabled={questionMode.addingImages || !questionnaireController.allQuestionsComplete}
          >Submit answers</button>
        {:else}
          <button
            class="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
            type="submit"
            disabled={questionMode.addingImages || !questionnaireController.currentDraftIsComplete()}
          >
            {#if !questionnaireController.requiresPreview}
              Submit answer
            {:else}
              {questionMode.state.activeTab === questionMode.questions.length - 1 ? "Preview" : "Next"}<ChevronRight class="size-3.5" aria-hidden="true" />
            {/if}
          </button>
        {/if}
      </div>
    {/if}
  </div>
  <p id="prompt-autocomplete-status" class="sr-only" aria-live="polite">
    {promptAssistiveStatus}
  </p>
</form>
</div>
