<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import EllipsisVertical from "@lucide/svelte/icons/ellipsis-vertical";
  import Eye from "@lucide/svelte/icons/eye";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import Mic from "@lucide/svelte/icons/mic";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import Pause from "@lucide/svelte/icons/pause";
  import Play from "@lucide/svelte/icons/play";
  import Square from "@lucide/svelte/icons/square";
  import WandSparkles from "@lucide/svelte/icons/wand-sparkles";
  import X from "@lucide/svelte/icons/x";
  import { onMount, tick } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import type { AvailableCommand } from "@agentclientprotocol/sdk";
  import type { Attachment } from "../lib/attachments";
  import type { AgentControlState } from "../lib/agent-control";
  import {
    advanceQuestionnaire,
    chooseCustomAnswer,
    chooseQuestionChoice,
    editQuestion,
    questionnaireIsComplete,
    questionDraftIsComplete,
    questionDraftSelectionCount,
    removeQuestionImage,
    selectQuestionnaireTab,
    toggleCustomAnswer,
    toggleQuestionChoice,
    updateCustomAnswer,
    type DesktopQuestion,
    type QuestionComposerMode,
    type QuestionImage,
  } from "../lib/question";
  import {
    PromptAutocompleteController,
    type PromptAutocompleteState,
  } from "../lib/autocomplete";
  import {
    insertPromptPaths,
    projectTreeDragPayloadFromUnknown,
    PROJECT_TREE_DRAG_STATE_EVENT,
    PROJECT_TREE_DROP_EVENT,
  } from "../lib/project-tree";
  import {
    matchSlashCommands,
    shouldSubmitAcceptedSlashCommand,
    slashCommandInsertion,
    slashCommandQuery,
    type SlashCommandMatch,
  } from "../lib/slash-commands";
  import AttachmentGrid from "./AttachmentGrid.svelte";
  import {
    browserDeepgramSupported,
    DeepgramDictationController,
    type DeepgramDictationState,
    type DeepgramToken,
  } from "../lib/deepgram";

  let {
    promptText = $bindable(""),
    attachments,
    variant = "prompt",
    placeholder,
    ariaLabel,
    availableCommands = [],
    activeSessionId,
    ready,
    promptRunning,
    agentControlState = "idle",
    dragActive,
    autocompleteEnabled,
    autocompleteDebounceMs,
    questionMode,
    onAutocomplete,
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
    ready: boolean;
    promptRunning: boolean;
    agentControlState?: AgentControlState;
    dragActive: boolean;
    autocompleteEnabled: boolean;
    autocompleteDebounceMs: number;
    questionMode?: QuestionComposerMode;
    onAutocomplete: (draft: string, signal: AbortSignal) => Promise<string>;
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

  let composerForm = $state<HTMLFormElement | undefined>();
  let textarea = $state<HTMLTextAreaElement | undefined>();
  let ghostLayer = $state<HTMLDivElement | undefined>();
  let slashListbox = $state<HTMLDivElement | undefined>();
  let autocompleteSuggestion = $state("");
  let composing = $state(false);
  let selectionStart = $state(promptText.length);
  let selectionEnd = $state(promptText.length);
  let projectPathDragActive = $state(false);
  let selectedSlashCommand = $state(0);
  let dismissedSlashDraft = $state<string | null>(null);
  let slashMenuKey = "";
  let questionModeActive = false;
  let restoreFocusElement: HTMLElement | null = null;
  let voiceController: DeepgramDictationController | undefined;
  let voiceState = $state<DeepgramDictationState>("idle");
  let voiceInterim = $state<string | undefined>();
  let voiceError = $state("");
  let voiceSupported = $state(false);
  let voiceSessionId = $state<string | undefined>();
  let composerMenuOpen = $state(false);
  const autocompleteController = new PromptAutocompleteController({
    request: (draft, signal) => onAutocomplete(draft, signal),
    onSuggestion: (suggestion) => {
      autocompleteSuggestion = suggestion;
      requestAnimationFrame(syncGhostLayer);
    },
  });

  const previewing = $derived(!!questionMode && questionMode.state.activeTab === questionMode.questions.length);
  const editorMode = $derived(variant === "editor" && !questionMode);
  const currentQuestion = $derived(
    questionMode && !previewing ? questionMode.questions[questionMode.state.activeTab] : undefined,
  );
  const currentDraft = $derived(
    questionMode && currentQuestion ? questionMode.state.drafts[currentQuestion.id] : undefined,
  );
  const allQuestionsComplete = $derived(
    questionMode ? questionnaireIsComplete(questionMode.state, questionMode.questions) : false,
  );
  const questionAttachments = $derived(
    currentQuestion && currentDraft?.customSelected
      ? currentDraft.images.map((image, index) => imageAttachment(currentQuestion.id, image, index))
      : [],
  );
  const currentSelectionCount = $derived(questionDraftSelectionCount(currentDraft));
  const displayedAttachments = $derived(questionMode ? questionAttachments : attachments);
  const textareaValue = $derived(composerText());
  const hasQueueableDraft = $derived(!questionMode && (promptText.trim().length > 0 || attachments.length > 0));
  const canCreateTask = $derived(
    !editorMode
      && !questionMode
      && !!onCreateTask
      && !!activeSessionId
      && ready
      && (hasQueueableDraft || voiceState !== "idle"),
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
  const voiceCanStart = $derived(
    !editorMode && !questionMode && voiceSupported && ready && !!activeSessionId,
  );
  const slashQuery = $derived.by(() => {
    if (editorMode || !ready || !activeSessionId || promptRunning || questionMode || composing || attachments.length > 0) {
      return undefined;
    }
    if (dismissedSlashDraft === promptText) return undefined;
    return slashCommandQuery(promptText, selectionStart, selectionEnd);
  });
  const slashMatches = $derived.by(() => (
    slashQuery === undefined ? [] : matchSlashCommands(availableCommands, slashQuery)
  ));
  const slashMenuOpen = $derived(slashMatches.length > 0);
  const activeSlashMatch = $derived(slashMatches[selectedSlashCommand]);
  const promptAssistiveStatus = $derived.by(() => {
    if (slashMenuOpen) {
      return `${slashMatches.length} slash commands available. Use arrow keys to navigate, then Tab or Enter to choose.`;
    }
    if (!questionMode && autocompleteSuggestion) {
      return "Autocomplete available. Press Tab to accept or Escape to dismiss.";
    }
    return "";
  });
  const slashListboxId = "prompt-slash-command-listbox";

  function composerText(): string {
    if (!questionMode) return promptText;
    return currentDraft?.customSelected ? currentDraft.customText : "";
  }

  function composerPlaceholder(): string {
    if (placeholder) return placeholder;
    if (questionMode) return "Type a custom answer or paste an image…";
    return activeSessionId
      ? "Ask Pix to change, explain, or investigate…"
      : "Start or load a conversation first";
  }

  function autocompleteState(target = textarea): PromptAutocompleteState {
    const text = target?.value ?? promptText;
    return {
      contextKey: activeSessionId ?? "",
      text,
      selectionStart: target?.selectionStart ?? text.length,
      selectionEnd: target?.selectionEnd ?? text.length,
      hasAttachments: attachments.length > 0,
      enabled: !editorMode && !questionMode && autocompleteEnabled && ready && !!activeSessionId && !composing,
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

  /** Focus the normal prompt editor after an external action restores a draft. */
  export async function focus(): Promise<void> {
    if (questionMode) return;
    await tick();
    if (!textarea) return;
    textarea.focus();
    const end = promptText.length;
    textarea.setSelectionRange(end, end);
    updateSelection(textarea);
    resizeComposer();
    observeAutocomplete(textarea);
  }

  /** Insert one or more filesystem paths as plain quoted text in the prompt. */
  export async function insertPaths(paths: readonly string[]): Promise<void> {
    if (questionMode || editorMode || !ready || !activeSessionId || paths.length === 0) return;
    const start = textarea?.selectionStart ?? selectionStart;
    const end = textarea?.selectionEnd ?? selectionEnd;
    const insertion = insertPromptPaths(promptText, start, end, paths);
    if (insertion.text === promptText) return;
    promptText = insertion.text;
    dismissedSlashDraft = null;
    autocompleteController.dismiss();
    await tick();
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(insertion.cursor, insertion.cursor);
    updateSelection(textarea);
    resizeComposer();
    observeAutocomplete(textarea);
  }

  $effect(() => {
    promptText;
    promptRunning;
    attachments.length;
    activeSessionId;
    ready;
    autocompleteEnabled;
    questionMode?.state.activeTab;
    currentDraft?.customText;
    currentDraft?.images.length;
    currentDraft?.choiceValues;
    currentDraft?.customSelected;
    autocompleteController.setDebounceMs(autocompleteDebounceMs);
    observeAutocomplete();
    const frame = requestAnimationFrame(resizeComposer);
    return () => cancelAnimationFrame(frame);
  });

  $effect(() => {
    if (dismissedSlashDraft !== null && dismissedSlashDraft !== promptText) dismissedSlashDraft = null;
  });

  $effect(() => {
    const key = slashQuery === undefined
      ? ""
      : `${slashQuery}\0${slashMatches.map(({ command }) => command.name).join("\0")}`;
    if (key !== slashMenuKey) {
      slashMenuKey = key;
      selectedSlashCommand = 0;
    } else if (selectedSlashCommand >= slashMatches.length) {
      selectedSlashCommand = Math.max(0, slashMatches.length - 1);
    }
    if (slashMenuOpen) {
      autocompleteController.dismiss();
      composerMenuOpen = false;
    }
  });

  $effect(() => {
    if (!slashMenuOpen || !slashListbox) return;
    const index = selectedSlashCommand;
    const frame = requestAnimationFrame(() => {
      slashListbox
        ?.querySelector<HTMLElement>(`[data-slash-command-index="${index}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  });

  $effect(() => () => autocompleteController.dispose());

  onMount(() => {
    voiceSupported = browserDeepgramSupported();
    if (!voiceSupported) return;
    voiceController = new DeepgramDictationController(
      {
        onState: (state) => { voiceState = state; },
        onFinal: (text) => { void insertVoiceTranscript(text, voiceSessionId); },
        onInterim: (text) => {
          voiceInterim = voiceSessionId === activeSessionId ? text : undefined;
        },
        onError: (message) => { voiceError = message; },
      },
      async () => await invoke<DeepgramToken>("deepgram_token"),
    );
    return () => {
      const controller = voiceController;
      voiceSessionId = undefined;
      voiceInterim = undefined;
      voiceController = undefined;
      if (controller) void controller.dispose();
    };
  });

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
    if (editorMode || questionMode || !activeSessionId || !ready) composerMenuOpen = false;
  });

  $effect(() => {
    if (voiceState === "idle") return;
    if (!activeSessionId || voiceSessionId !== activeSessionId || !ready || editorMode || questionMode) {
      voiceSessionId = undefined;
      voiceInterim = undefined;
      void stopVoiceInput();
    }
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

  $effect(() => {
    const active = !!questionMode;
    if (active && !questionModeActive) {
      restoreFocusElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      questionModeActive = true;
      void tick().then(() => {
        composerForm?.querySelector<HTMLButtonElement>(`[data-question-tab="${questionMode?.state.activeTab ?? 0}"]`)?.focus();
      });
    } else if (!active && questionModeActive) {
      questionModeActive = false;
      const focusTarget = restoreFocusElement;
      restoreFocusElement = null;
      void tick().then(() => {
        if (focusTarget?.isConnected) focusTarget.focus();
        else textarea?.focus();
      });
    }
  });

  function updateQuestionState(state: QuestionComposerMode["state"]): void {
    questionMode?.onStateChange(state);
  }

  async function handleSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!questionMode) {
      await stopVoiceInput();
      await onSubmit();
      return;
    }
    if (questionMode.addingImages) return;
    if (previewing) {
      if (allQuestionsComplete) questionMode.onSubmit(questionMode.state);
      return;
    }
    const next = advanceQuestionnaire(questionMode.state, questionMode.questions);
    if (next !== questionMode.state) {
      updateQuestionState(next);
      focusQuestionContent(next.activeTab);
    }
  }

  async function toggleVoiceInput(): Promise<void> {
    if (!voiceController) return;
    const starting = voiceController.currentState() === "idle";
    if (starting) {
      if (!voiceCanStart || !activeSessionId) return;
      voiceSessionId = activeSessionId;
    }
    voiceError = "";
    autocompleteController.dismiss();
    await voiceController.toggle();
    if (voiceController.currentState() === "idle") {
      voiceSessionId = undefined;
      voiceInterim = undefined;
    }
  }

  async function stopVoiceInput(): Promise<void> {
    const controller = voiceController;
    if (!controller) return;
    if (controller.currentState() !== "idle") await controller.stop();
    voiceSessionId = undefined;
    voiceInterim = undefined;
    await tick();
  }

  async function deferWithVoiceStop(): Promise<void> {
    composerMenuOpen = false;
    if (!activeSessionId || !ready || !hasQueueableDraft) return;
    await stopVoiceInput();
    await onDefer();
  }

  async function createTaskWithVoiceStop(): Promise<void> {
    composerMenuOpen = false;
    if (!canCreateTask || !onCreateTask) return;
    await stopVoiceInput();
    await onCreateTask();
  }

  async function enhanceWithVoiceStop(): Promise<void> {
    composerMenuOpen = false;
    if (!canEnhancePrompt || !onEnhance) return;
    await stopVoiceInput();
    if (promptText.trim().length < 3) return;
    await onEnhance();
    await focus();
  }

  function toggleComposerMenu(): void {
    composerMenuOpen = !composerMenuOpen;
    if (!composerMenuOpen) return;
    dismissedSlashDraft = promptText;
    autocompleteController.dismiss();
  }

  async function insertVoiceTranscript(rawText: string, sessionId: string | undefined): Promise<void> {
    if (editorMode || questionMode || !sessionId || sessionId !== activeSessionId) return;
    const transcript = rawText.trim().replace(/\s+/gu, " ");
    if (!transcript) return;
    const start = textarea?.selectionStart ?? selectionStart;
    const end = textarea?.selectionEnd ?? selectionEnd;
    const before = promptText.slice(0, start);
    const after = promptText.slice(end);
    const prefix = before.length > 0 && !/\s$/u.test(before) ? " " : "";
    const suffix = after.length > 0 && !/^\s/u.test(after) ? " " : "";
    const insertion = `${prefix}${transcript}${suffix}`;
    promptText = `${before}${insertion}${after}`;
    const cursor = before.length + insertion.length;
    dismissedSlashDraft = null;
    autocompleteController.dismiss();
    await tick();
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(cursor, cursor);
    updateSelection(textarea);
    resizeComposer();
    observeAutocomplete(textarea);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (!editorMode && !questionMode && slashMenuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        selectedSlashCommand = (selectedSlashCommand + direction + slashMatches.length) % slashMatches.length;
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        dismissedSlashDraft = promptText;
        autocompleteController.dismiss();
        return;
      }
      if (
        (event.key === "Tab" || event.key === "Enter")
        && !event.shiftKey
        && !event.ctrlKey
        && !event.altKey
        && !event.metaKey
        && !event.isComposing
        && activeSlashMatch
      ) {
        event.preventDefault();
        void acceptSlashCommand(activeSlashMatch, event.key === "Enter");
        return;
      }
    }
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
    if (!editorMode && !questionMode && event.key === "Escape" && autocompleteSuggestion) {
      event.preventDefault();
      autocompleteController.dismiss();
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
    if (questionMode && currentQuestion) {
      updateQuestionState(updateCustomAnswer(questionMode.state, currentQuestion.id, value, currentQuestion));
    } else {
      promptText = value;
    }
    updateSelection(target);
    resizeComposer();
    observeAutocomplete(target);
  }

  function handleKeyup(event: KeyboardEvent): void {
    updateSelection(event.currentTarget as HTMLTextAreaElement);
    if (event.key === "Tab" || event.key === "Escape") return;
    observeAutocomplete(event.currentTarget as HTMLTextAreaElement);
  }

  function handleSelection(event: Event): void {
    const target = event.currentTarget as HTMLTextAreaElement;
    updateSelection(target);
    observeAutocomplete(target);
  }

  function updateSelection(target: HTMLTextAreaElement): void {
    selectionStart = target.selectionStart;
    selectionEnd = target.selectionEnd;
  }

  async function acceptSlashCommand(match: SlashCommandMatch, submit: boolean): Promise<void> {
    promptText = slashCommandInsertion(match.command);
    dismissedSlashDraft = submit ? null : promptText;
    autocompleteController.dismiss();
    await tick();
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(promptText.length, promptText.length);
    updateSelection(textarea);
    resizeComposer();
    observeAutocomplete(textarea);
    if (submit && shouldSubmitAcceptedSlashCommand(match)) await onSubmit();
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
    const target = event.currentTarget as HTMLTextAreaElement;
    updateSelection(target);
    observeAutocomplete(target);
  }

  function handlePaste(event: ClipboardEvent): void {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    if (questionMode && currentQuestion && currentDraft?.customSelected) {
      void questionMode.onPasteImages(currentQuestion.id, files);
    } else if (!questionMode) {
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
    if (projectPathDragActive) autocompleteController.dismiss();
  }

  function handleProjectTreeDropEvent(event: Event): void {
    projectPathDragActive = false;
    if (!canAcceptProjectTreeDrop()) return;
    const entry = projectTreeDragPayloadFromUnknown((event as CustomEvent<unknown>).detail);
    if (!entry) return;
    void insertPaths([entry.path]);
  }

  function chooseChoice(choiceValue: string): void {
    if (!questionMode || !currentQuestion) return;
    const state = currentQuestion.multiple
      ? toggleQuestionChoice(questionMode.state, currentQuestion, choiceValue)
      : chooseQuestionChoice(questionMode.state, currentQuestion.id, choiceValue);
    updateQuestionState(state);
  }

  async function chooseCustom(): Promise<void> {
    if (!questionMode || !currentQuestion) return;
    const state = currentQuestion.multiple
      ? toggleCustomAnswer(questionMode.state, currentQuestion)
      : chooseCustomAnswer(questionMode.state, currentQuestion.id);
    updateQuestionState(state);
    if (!state.drafts[currentQuestion.id]?.customSelected) return;
    await tick();
    textarea?.focus();
  }

  function selectTab(index: number): void {
    if (!questionMode) return;
    updateQuestionState(selectQuestionnaireTab(questionMode.state, index, questionMode.questions));
  }

  function editAnswer(index: number): void {
    if (!questionMode) return;
    updateQuestionState(editQuestion(questionMode.state, index));
    focusQuestionContent(index);
  }

  function focusQuestionContent(index: number): void {
    void tick().then(() => {
      if (!questionMode) return;
      if (index >= questionMode.questions.length) {
        composerForm?.querySelector<HTMLButtonElement>(`[data-question-tab="${index}"]`)?.focus();
        return;
      }
      composerForm?.querySelector<HTMLButtonElement>("[data-question-choice]")?.focus();
    });
  }

  function handleQuestionEscape(event: KeyboardEvent): void {
    if (!questionMode || event.key !== "Escape" || event.isComposing) return;
    event.preventDefault();
    questionMode.onCancel();
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (composerMenuOpen && event.key === "Escape" && !event.isComposing) {
      event.preventDefault();
      composerMenuOpen = false;
      textarea?.focus();
      return;
    }
    handleQuestionEscape(event);
  }

  function handleTabKeydown(event: KeyboardEvent, index: number): void {
    if (!questionMode) return;
    const tabCount = questionMode.questions.length + 1;
    let nextIndex: number;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabCount;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabCount) % tabCount;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabCount - 1;
    else return;
    event.preventDefault();
    selectTab(nextIndex);
    void tick().then(() => {
      composerForm?.querySelector<HTMLButtonElement>(`[data-question-tab="${nextIndex}"]`)?.focus();
    });
  }

  function selectedChoiceIndex(): number {
    if (!currentQuestion || !currentDraft) return 0;
    const selectedIndex = currentQuestion.choices.findIndex((choice) => currentDraft.choiceValues.includes(choice.value));
    if (selectedIndex === -1 && currentDraft.customSelected) return currentQuestion.choices.length;
    return Math.max(0, selectedIndex);
  }

  function chooseAnswerAt(index: number): void {
    if (!questionMode || !currentQuestion) return;
    const choice = currentQuestion.choices[index];
    let state: QuestionComposerMode["state"];
    if (currentQuestion.multiple) {
      state = choice
        ? toggleQuestionChoice(questionMode.state, currentQuestion, choice.value)
        : toggleCustomAnswer(questionMode.state, currentQuestion);
    } else {
      state = choice
        ? chooseQuestionChoice(questionMode.state, currentQuestion.id, choice.value)
        : chooseCustomAnswer(questionMode.state, currentQuestion.id);
    }
    updateQuestionState(state);
  }

  function handleChoiceKeydown(event: KeyboardEvent, index: number): void {
    if (!currentQuestion) return;
    const choiceCount = currentQuestion.choices.length + 1;
    let nextIndex: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % choiceCount;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + choiceCount) % choiceCount;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = choiceCount - 1;
    else return;
    event.preventDefault();
    if (!currentQuestion.multiple) chooseAnswerAt(nextIndex);
    void tick().then(() => {
      composerForm?.querySelector<HTMLButtonElement>(`[data-question-choice="${nextIndex}"]`)?.focus();
    });
  }

  function removeDisplayedAttachment(id: string): void {
    if (!questionMode || !currentQuestion) {
      onRemoveAttachment(id);
      return;
    }
    const imageIndex = Number(id.split(":").at(-1));
    if (Number.isInteger(imageIndex)) {
      updateQuestionState(removeQuestionImage(questionMode.state, currentQuestion.id, imageIndex));
    }
  }

  function openDisplayedAttachment(attachment: Attachment): void {
    if (!questionMode || !currentDraft) {
      onOpenAttachment(attachment);
      return;
    }
    const imageIndex = Number(attachment.id.split(":").at(-1));
    const image = currentDraft.images[imageIndex];
    if (image) questionMode.onOpenImage(image);
  }

  function answerLabel(question: DesktopQuestion): string {
    if (!questionMode) return "Not answered";
    const draft = questionMode.state.drafts[question.id];
    if (!draft || !questionDraftIsComplete(draft, question)) return "Not answered";
    if (question.multiple) {
      const labels = question.choices
        .filter((choice) => draft.choiceValues.includes(choice.value))
        .map((choice) => choice.label);
      if (draft.customSelected) labels.push(customAnswerLabel(draft.customText, draft.images.length));
      return labels.join(", ");
    }
    if (!draft.customSelected) {
      return question.choices.find((choice) => draft.choiceValues.includes(choice.value))?.label ?? "Not answered";
    }
    return customAnswerLabel(draft.customText, draft.images.length);
  }

  function customAnswerLabel(customText: string, images: number): string {
    const text = customText.trim();
    if (text && images) return `${text} · ${images} image${images === 1 ? "" : "s"}`;
    if (text) return text;
    return `${images} image${images === 1 ? "" : "s"}`;
  }

  function imageAttachment(questionId: string, image: QuestionImage, index: number): Attachment {
    return {
      id: `question-image:${questionId}:${index}`,
      name: image.name,
      kind: "image",
      mimeType: image.mimeType,
      size: image.size,
      dataUrl: `data:${image.mimeType};base64,${image.data}`,
    };
  }
</script>

<svelte:window onresize={resizeComposer} onkeydown={handleWindowKeydown} />

<div class={editorMode ? "relative" : "relative border-t border-border bg-panel px-3 py-1.5"}>
{#if slashMenuOpen}
  <div
    bind:this={slashListbox}
    class="absolute right-0 bottom-[calc(100%+0.375rem)] left-0 z-30 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-md"
    id={slashListboxId}
    role="listbox"
    aria-label="Slash commands"
  >
    {#each slashMatches as match, index (`${match.command.name}:${index}`)}
      <button
        class={[
          "flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left transition-colors",
          index === selectedSlashCommand ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
        ]}
        type="button"
        id={`prompt-slash-command-${index}`}
        data-slash-command-index={index}
        role="option"
        aria-selected={index === selectedSlashCommand}
        tabindex="-1"
        onmousedown={(event) => event.preventDefault()}
        onmouseenter={() => selectedSlashCommand = index}
        onclick={() => void acceptSlashCommand(match, false)}
      >
        <span class="min-w-0 flex-1">
          <span class="flex min-w-0 items-baseline gap-2">
            <span class="shrink-0 font-mono text-xs font-semibold text-foreground">/{match.command.name}</span>
            {#if match.inputHint}
              <span class="truncate font-mono text-[11px] text-muted-foreground">{match.inputHint}</span>
            {/if}
          </span>
          <span class="mt-0.5 block truncate text-[11px] text-muted-foreground">{match.command.description}</span>
        </span>
        {#if match.source}
          <span class="mt-0.5 shrink-0 rounded border border-border/80 px-1.5 py-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{match.source}</span>
        {/if}
      </button>
    {/each}
  </div>
{/if}

{#if composerMenuOpen && !editorMode && !questionMode}
  <div
    class="absolute right-3 bottom-[calc(100%+0.375rem)] z-40 w-44 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
    data-composer-menu
    role="menu"
    aria-label="Composer actions"
  >
    <button
      class="flex h-8 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
      type="button"
      role="menuitem"
      disabled={!canEnhancePrompt}
      onclick={() => void enhanceWithVoiceStop()}
    >
      <WandSparkles class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>Enhance prompt</span>
    </button>
    <button
      class="flex h-8 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
      type="button"
      role="menuitem"
      disabled={!canCreateTask}
      onclick={() => void createTaskWithVoiceStop()}
    >
      <ListTodo class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>Create task</span>
    </button>
    <button
      class="flex h-8 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
      type="button"
      role="menuitem"
      disabled={!activeSessionId || !ready || !hasQueueableDraft}
      onclick={() => void deferWithVoiceStop()}
    >
      <Pause class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>Pause for later</span>
    </button>
  </div>
{/if}

<form
  class={[
    "overflow-hidden rounded-md border bg-panel-strong focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/25",
    dragActive || projectPathDragActive ? "border-ring ring-1 ring-ring/40" : "border-input",
  ]}
  bind:this={composerForm}
  data-pix-project-path-drop-target="true"
  onsubmit={handleSubmit}
>
  {#if questionMode}
    <div class="border-b border-border bg-panel px-3 pt-2.5">
      <div class="mb-2 flex items-center justify-between gap-3">
        <p class="min-w-0 truncate text-[11px] font-medium text-muted-foreground">{questionMode.message}</p>
        <button
          class="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          type="button"
          aria-label="Cancel questions"
          title="Cancel questions"
          onclick={questionMode.onCancel}
        ><X class="size-3.5" aria-hidden="true" /></button>
      </div>
      <div class="flex min-w-0 gap-1 overflow-x-auto" role="tablist" aria-label="Questions">
        {#each questionMode.questions as question, index}
          {@const complete = questionDraftIsComplete(questionMode.state.drafts[question.id], question)}
          <button
            class={[
              "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-t-md border-x border-t px-2.5 text-xs font-medium transition-colors focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
              questionMode.state.activeTab === index
                ? "border-border bg-panel-strong text-foreground"
                : "border-transparent text-muted-foreground hover:bg-panel-hover hover:text-foreground",
            ]}
            type="button"
            role="tab"
            id={`question-composer-tab-${index}`}
            data-question-tab={index}
            aria-selected={questionMode.state.activeTab === index}
            aria-controls="question-composer-panel"
            tabindex={questionMode.state.activeTab === index ? 0 : -1}
            onclick={() => selectTab(index)}
            onkeydown={(event) => handleTabKeydown(event, index)}
          >
            <span class="grid size-3 shrink-0 place-items-center" aria-hidden="true">
              {#if complete}<Check class="size-3 text-primary" strokeWidth={2.25} />{/if}
            </span>
            <span>{question.label}</span>
          </button>
        {/each}
        <button
          class={[
            "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-t-md border-x border-t px-2.5 text-xs font-medium transition-colors focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
            previewing
              ? "border-border bg-panel-strong text-foreground"
              : "border-transparent text-muted-foreground hover:bg-panel-hover hover:text-foreground",
          ]}
          type="button"
          role="tab"
          id={`question-composer-tab-${questionMode.questions.length}`}
          data-question-tab={questionMode.questions.length}
          aria-selected={previewing}
          aria-controls="question-composer-panel"
          tabindex={previewing ? 0 : -1}
          onclick={() => selectTab(questionMode.questions.length)}
          onkeydown={(event) => handleTabKeydown(event, questionMode.questions.length)}
        ><Eye class="size-3" aria-hidden="true" />Preview</button>
      </div>
    </div>

    <div
      id="question-composer-panel"
      class="max-h-[min(52vh,32rem)] overflow-y-auto px-3 pt-3"
      role="tabpanel"
      aria-labelledby={`question-composer-tab-${questionMode.state.activeTab}`}
    >
      {#if previewing}
        <div class="mb-3 flex items-start justify-between gap-4">
          <div>
            <p class="text-sm font-semibold text-foreground">Preview answers</p>
            <p class="mt-0.5 text-xs text-muted-foreground">Review every answer before sending.</p>
          </div>
          <span class={[
            "rounded-full px-2 py-0.5 text-[11px] font-semibold",
            allQuestionsComplete ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive",
          ]}>{allQuestionsComplete ? "Ready" : "Incomplete"}</span>
        </div>
        <div class="mb-3 divide-y divide-border/70 border-t border-border/70">
          {#each questionMode.questions as question, index}
            {@const complete = questionDraftIsComplete(questionMode.state.drafts[question.id], question)}
            <button
              class={[
                "group flex w-full items-start gap-2.5 px-2 py-2 text-left transition-colors focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
                complete ? "hover:bg-panel-hover" : "bg-destructive/5 hover:bg-destructive/10",
              ]}
              type="button"
              onclick={() => editAnswer(index)}
            >
              <span class={[
                "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full",
                complete ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive",
              ]}>{#if complete}<Check class="size-2.5" strokeWidth={2.4} />{:else}<span class="text-[11px] leading-none">!</span>{/if}</span>
              <span class="min-w-0 flex-1">
                <span class="block text-xs font-semibold text-foreground">{question.label}</span>
                <span class={[
                  "mt-0.5 block text-xs whitespace-pre-wrap break-words",
                  complete ? "text-muted-foreground" : "font-medium text-destructive",
                ]}>{answerLabel(question)}</span>
              </span>
              <span class="text-[11px] font-medium text-muted-foreground group-hover:text-foreground">Edit</span>
            </button>
          {/each}
        </div>
      {:else if currentQuestion && currentDraft}
        {@const maxSelections = currentQuestion.maxSelections ?? currentQuestion.choices.length + 1}
        {@const atSelectionLimit = currentQuestion.multiple && currentSelectionCount >= maxSelections}
        <div class="mb-3 flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-sm leading-relaxed font-medium whitespace-pre-wrap text-foreground">{currentQuestion.prompt}</p>
            {#if currentQuestion.multiple}
              <p id="question-selection-hint" class="mt-1 text-[11px] text-muted-foreground" aria-live="polite">
                Select {currentQuestion.minSelections ?? 1}–{maxSelections} answers · {currentSelectionCount} selected
              </p>
            {/if}
          </div>
          <span class="mt-0.5 shrink-0 text-[11px] tabular-nums text-muted-foreground">{questionMode.state.activeTab + 1}/{questionMode.questions.length}</span>
        </div>
        <div
          class="mb-3 divide-y divide-border/70 border-t border-border/70"
          role={currentQuestion.multiple ? "group" : "radiogroup"}
          aria-label={currentQuestion.label}
          aria-describedby={currentQuestion.multiple ? "question-selection-hint" : undefined}
        >
          {#each currentQuestion.choices as choice, choiceIndex}
            {@const selected = currentDraft.choiceValues.includes(choice.value)}
            {@const blocked = atSelectionLimit && !selected}
            <button
              class={[
                "flex w-full items-start gap-2.5 px-2 py-2 text-left transition-colors focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
                selected ? "bg-panel-selected" : "hover:bg-panel-hover",
                blocked && "cursor-not-allowed opacity-45",
              ]}
              type="button"
              role={currentQuestion.multiple ? "checkbox" : "radio"}
              data-question-choice={choiceIndex}
              aria-checked={selected}
              aria-disabled={blocked || undefined}
              tabindex={selectedChoiceIndex() === choiceIndex ? 0 : -1}
              onclick={() => chooseChoice(choice.value)}
              onkeydown={(event) => handleChoiceKeydown(event, choiceIndex)}
            >
              <span class={[
                "mt-0.5 grid size-4 shrink-0 place-items-center border",
                currentQuestion.multiple ? "rounded-sm" : "rounded-full",
                selected ? "border-primary" : "border-muted-foreground/50",
              ]}>{#if selected}{#if currentQuestion.multiple}<Check class="size-3 text-primary" strokeWidth={2.4} />{:else}<span class="size-2 rounded-full bg-primary"></span>{/if}{/if}</span>
              <span class="min-w-0">
                <span class="block text-xs font-medium text-foreground">{choice.label}</span>
                {#if choice.description}<span class="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{choice.description}</span>{/if}
              </span>
            </button>
          {/each}
          <button
            class={[
              "flex w-full items-start gap-2.5 px-2 py-2 text-left transition-colors focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
              currentDraft.customSelected ? "bg-panel-selected" : "hover:bg-panel-hover",
              atSelectionLimit && !currentDraft.customSelected && "cursor-not-allowed opacity-45",
            ]}
            type="button"
            role={currentQuestion.multiple ? "checkbox" : "radio"}
            data-question-choice={currentQuestion.choices.length}
            aria-checked={currentDraft.customSelected}
            aria-disabled={(atSelectionLimit && !currentDraft.customSelected) || undefined}
            tabindex={selectedChoiceIndex() === currentQuestion.choices.length ? 0 : -1}
            onclick={chooseCustom}
            onkeydown={(event) => handleChoiceKeydown(event, currentQuestion.choices.length)}
          >
            <span class={[
              "mt-0.5 grid size-4 shrink-0 place-items-center border",
              currentQuestion.multiple ? "rounded-sm" : "rounded-full",
              currentDraft.customSelected ? "border-primary" : "border-muted-foreground/50",
            ]}>{#if currentDraft.customSelected}{#if currentQuestion.multiple}<Check class="size-3 text-primary" strokeWidth={2.4} />{:else}<span class="size-2 rounded-full bg-primary"></span>{/if}{/if}</span>
            <span class="text-xs font-medium text-foreground">Something else…</span>
          </button>
        </div>
      {/if}
    </div>
  {/if}

  <div class={questionMode ? "px-3 pt-2 pb-2" : "px-3 pt-2.5 pb-2"}>
    {#if !questionMode || currentDraft?.customSelected}
      <AttachmentGrid
        attachments={displayedAttachments}
        variant="composer"
        onOpen={openDisplayedAttachment}
        onRemove={removeDisplayedAttachment}
      />
      <div class="flex items-end gap-1 text-sm">
        <button
          class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
          type="button"
          aria-label={questionMode ? "Attach images" : "Attach files"}
          title={questionMode ? "Attach images" : "Attach files"}
          disabled={questionMode ? questionMode.addingImages : editorMode ? !ready : !activeSessionId || !ready}
          onclick={() => {
            if (questionMode && currentQuestion) void questionMode.onChooseImages(currentQuestion.id);
            else void onChooseAttachments();
          }}
        >
          <Paperclip class="h-4 w-4" aria-hidden="true" />
        </button>
        <div class="relative min-w-0 flex-1">
          {#if autocompleteSuggestion && !editorMode && !questionMode}
            <div
              class="pointer-events-none absolute inset-0 overflow-hidden px-0.5 leading-relaxed whitespace-pre-wrap break-words"
              bind:this={ghostLayer}
              aria-hidden="true"
            ><span class="text-transparent">{promptText}</span><span class="text-muted-foreground/45">{autocompleteSuggestion}</span></div>
          {/if}
          <textarea
            class="relative z-10 block min-h-6 w-full resize-none overflow-y-hidden border-0 bg-transparent px-0.5 leading-relaxed text-foreground outline-none placeholder:text-muted-foreground placeholder:opacity-40 disabled:cursor-default disabled:opacity-40"
            bind:this={textarea}
            value={textareaValue}
            oninput={handleInput}
            onkeydown={handleKeydown}
            onkeyup={handleKeyup}
            onselect={handleSelection}
            onclick={handleSelection}
            onscroll={handleScroll}
            oncompositionstart={handleCompositionStart}
            oncompositionend={handleCompositionEnd}
            onpaste={handlePaste}
            aria-label={ariaLabel ?? (questionMode ? `Custom answer for ${currentQuestion?.label ?? "question"}` : editorMode ? "Editor" : "Message Pix")}
            aria-describedby="prompt-autocomplete-status"
            role={!editorMode && !questionMode ? "combobox" : undefined}
            aria-autocomplete={!editorMode && !questionMode ? "list" : undefined}
            aria-expanded={!editorMode && !questionMode ? slashMenuOpen : undefined}
            aria-controls={!editorMode && !questionMode && slashMenuOpen ? slashListboxId : undefined}
            aria-activedescendant={!editorMode && !questionMode && slashMenuOpen ? `prompt-slash-command-${selectedSlashCommand}` : undefined}
            placeholder={composerPlaceholder()}
            disabled={questionMode ? !currentQuestion : editorMode ? !ready : !activeSessionId || !ready}
            rows="1"
          ></textarea>
        </div>
        {#if !editorMode && !questionMode}
          <div class="relative shrink-0" data-composer-menu>
            <button
              class="grid h-6 w-6 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              type="button"
              aria-label="More composer actions"
              title="More actions"
              aria-haspopup="menu"
              aria-expanded={composerMenuOpen}
              onclick={toggleComposerMenu}
            >
              <EllipsisVertical class="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <button
            class={[
              "grid h-6 w-6 shrink-0 place-items-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40",
              voiceState === "listening"
                ? "text-destructive hover:bg-destructive/10"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            ]}
            type="button"
            aria-label={voiceState === "listening" ? "Stop voice input" : voiceState === "starting" ? "Connecting voice input" : "Start voice input"}
            title={voiceState === "listening" ? "Stop voice input" : voiceState === "starting" ? "Connecting to Deepgram…" : voiceSupported ? "Voice input" : "Voice input is unavailable in this WebView"}
            disabled={voiceState === "idle" && !voiceCanStart}
            onclick={() => void toggleVoiceInput()}
          >
            {#if voiceState === "starting"}
              <LoaderCircle class="h-4 w-4 animate-spin" aria-hidden="true" />
            {:else}
              <Mic class="h-4 w-4" aria-hidden="true" />
            {/if}
          </button>
        {/if}
        {#if promptRunning && !editorMode && !questionMode}
          <button
            class="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-border bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
            type="button"
            aria-label={agentControlState === "pause-requested" ? "Pause requested" : "Pause after current turn"}
            title={agentControlState === "pause-requested" ? "Pause requested" : "Pause after current turn"}
            disabled={agentControlState === "pause-requested" || agentControlState === "resuming"}
            onclick={onPause}
          >
            <Pause class="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            class="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-border bg-transparent text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            type="button"
            aria-label="Stop response"
            title="Stop response"
            onclick={onCancel}
          >
            <Square class="h-3 w-3 fill-current" aria-hidden="true" />
          </button>
        {:else if !editorMode && !questionMode && (agentControlState === "paused" || agentControlState === "continuable")}
          <button
            class="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-border bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            type="button"
            aria-label="Continue response"
            title="Continue response"
            onclick={onContinue}
          >
            <Play class="h-3.5 w-3.5 fill-current" aria-hidden="true" />
          </button>
        {/if}
      </div>
      {#if !editorMode && !questionMode && (voiceInterim || voiceError)}
        <p
          class={[
            "mt-1.5 truncate text-[11px]",
            voiceError ? "text-destructive" : "text-muted-foreground",
          ]}
          aria-live="polite"
        >{voiceError || `Listening: ${voiceInterim}`}</p>
      {/if}
    {/if}

    {#if questionMode}
      <div class="flex items-center justify-between gap-3 border-t border-border pt-2 {currentDraft?.customSelected ? 'mt-2' : ''}">
        <button
          class="rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          type="button"
          onclick={questionMode.onCancel}
        >Cancel</button>
        {#if questionMode.addingImages}<span class="ml-auto text-[11px] text-muted-foreground" aria-live="polite">Adding images…</span>{/if}
        {#if previewing}
          <button
            class="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
            type="submit"
            disabled={questionMode.addingImages || !allQuestionsComplete}
          >Submit answers</button>
        {:else}
          <button
            class="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
            type="submit"
            disabled={questionMode.addingImages || !questionDraftIsComplete(currentDraft, currentQuestion)}
          >{questionMode.state.activeTab === questionMode.questions.length - 1 ? "Preview" : "Next"}<ChevronRight class="size-3.5" aria-hidden="true" /></button>
        {/if}
      </div>
    {/if}
  </div>
  <p id="prompt-autocomplete-status" class="sr-only" aria-live="polite">
    {promptAssistiveStatus}
  </p>
</form>
</div>
