import { tick } from "svelte";
import {
  PromptAutocompleteController,
  type PromptAutocompleteState,
} from "../lib/autocomplete";

interface PromptComposerTextareaControllerOptions {
  readonly textarea: () => HTMLTextAreaElement | undefined;
  readonly ghostLayer: () => HTMLDivElement | undefined;
  readonly composerForm: () => HTMLFormElement | undefined;
  readonly promptText: () => string;
  readonly setPromptText: (value: string) => void;
  readonly activeSessionId: () => string | null;
  readonly attachmentsCount: () => number;
  readonly editorMode: () => boolean;
  readonly questionMode: () => boolean;
  readonly autocompleteEnabled: () => boolean;
  readonly ready: () => boolean;
  readonly requestAutocomplete: (draft: string, signal: AbortSignal) => Promise<string>;
}

export function createPromptComposerTextareaController(options: PromptComposerTextareaControllerOptions) {
  let suggestion = $state("");
  let composing = $state(false);
  let selectionStart = $state(options.promptText().length);
  let selectionEnd = $state(options.promptText().length);

  const autocomplete = new PromptAutocompleteController({
    request: options.requestAutocomplete,
    onSuggestion: (nextSuggestion: string) => {
      suggestion = nextSuggestion;
      requestAnimationFrame(syncGhostLayer);
    },
  });

  function state(target = options.textarea()): PromptAutocompleteState {
    const text = target?.value ?? options.promptText();
    return {
      contextKey: options.activeSessionId() ?? "",
      text,
      selectionStart: target?.selectionStart ?? text.length,
      selectionEnd: target?.selectionEnd ?? text.length,
      hasAttachments: options.attachmentsCount() > 0,
      enabled: !options.editorMode()
        && !options.questionMode()
        && options.autocompleteEnabled()
        && options.ready()
        && !!options.activeSessionId()
        && !composing,
    };
  }

  function observe(target = options.textarea()): void {
    autocomplete.observe(state(target));
  }

  function syncGhostLayer(): void {
    const textarea = options.textarea();
    const ghostLayer = options.ghostLayer();
    if (!textarea || !ghostLayer) return;
    ghostLayer.style.paddingRight = `${Math.max(2, textarea.offsetWidth - textarea.clientWidth + 2)}px`;
    ghostLayer.scrollTop = textarea.scrollTop;
  }

  function resize(): void {
    const textarea = options.textarea();
    if (!textarea) return;

    textarea.style.height = "auto";
    const composerForm = options.composerForm();
    const composerChromeHeight = composerForm ? composerForm.offsetHeight - textarea.offsetHeight : 0;
    const maxTextareaHeight = Math.max(24, window.innerHeight / 2 - composerChromeHeight);
    const height = Math.min(textarea.scrollHeight, maxTextareaHeight);

    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxTextareaHeight ? "auto" : "hidden";
    syncGhostLayer();
  }

  function updateSelection(target: HTMLTextAreaElement): void {
    selectionStart = target.selectionStart;
    selectionEnd = target.selectionEnd;
  }

  function dismiss(): void {
    autocomplete.dismiss();
  }

  function setDebounceMs(value: number): void {
    autocomplete.setDebounceMs(value);
  }

  function handleInput(target: HTMLTextAreaElement): void {
    updateSelection(target);
    resize();
    observe(target);
  }

  function handleKeyup(event: KeyboardEvent): void {
    const target = event.currentTarget as HTMLTextAreaElement;
    updateSelection(target);
    if (event.key === "Tab" || event.key === "Escape") return;
    observe(target);
  }

  function handleSelection(event: Event): void {
    const target = event.currentTarget as HTMLTextAreaElement;
    updateSelection(target);
    observe(target);
  }

  function handleScroll(event: Event): void {
    const ghostLayer = options.ghostLayer();
    if (ghostLayer) ghostLayer.scrollTop = (event.currentTarget as HTMLTextAreaElement).scrollTop;
  }

  function handleCompositionStart(): void {
    composing = true;
    observe();
  }

  function handleCompositionEnd(event: CompositionEvent): void {
    composing = false;
    const target = event.currentTarget as HTMLTextAreaElement;
    updateSelection(target);
    observe(target);
  }

  function acceptAutocomplete(target: HTMLTextAreaElement): boolean {
    const accepted = autocomplete.accept(state(target));
    if (accepted === undefined) return false;
    options.setPromptText(accepted);
    void focusAt(accepted.length);
    return true;
  }

  async function focusAt(cursor: number): Promise<void> {
    await tick();
    const textarea = options.textarea();
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(cursor, cursor);
    updateSelection(textarea);
    resize();
    observe(textarea);
  }

  async function focusPrompt(): Promise<void> {
    if (options.questionMode()) return;
    await focusAt(options.promptText().length);
  }

  async function replacePromptText(value: string, cursor: number): Promise<void> {
    options.setPromptText(value);
    dismiss();
    await focusAt(cursor);
  }

  function dispose(): void {
    autocomplete.dispose();
  }

  return {
    get suggestion() { return suggestion; },
    get composing() { return composing; },
    get selectionStart() { return selectionStart; },
    get selectionEnd() { return selectionEnd; },
    observe,
    resize,
    updateSelection,
    dismiss,
    setDebounceMs,
    handleInput,
    handleKeyup,
    handleSelection,
    handleScroll,
    handleCompositionStart,
    handleCompositionEnd,
    acceptAutocomplete,
    focusAt,
    focusPrompt,
    replacePromptText,
    dispose,
  };
}

export type PromptComposerTextareaController = ReturnType<typeof createPromptComposerTextareaController>;
