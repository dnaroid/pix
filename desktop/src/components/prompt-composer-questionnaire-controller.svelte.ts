import { tick } from "svelte";
import type { Attachment } from "../lib/attachments";
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

interface PromptComposerQuestionnaireControllerOptions {
  readonly mode: () => QuestionComposerMode | undefined;
  readonly form: () => HTMLFormElement | undefined;
  readonly textarea: () => HTMLTextAreaElement | undefined;
  readonly attachments: () => readonly Attachment[];
  readonly removeAttachment: (id: string) => void;
  readonly openAttachment: (attachment: Attachment) => void;
}

export function createPromptComposerQuestionnaireController(
  options: PromptComposerQuestionnaireControllerOptions,
) {
  let modeActive = false;
  let restoreFocusElement: HTMLElement | null = null;

  const requiresPreview = $derived.by(() => (options.mode()?.questions.length ?? 0) > 1);
  const previewing = $derived.by(() => {
    const mode = options.mode();
    return !!mode && requiresPreview && mode.state.activeTab === mode.questions.length;
  });
  const currentQuestion = $derived.by(() => {
    const mode = options.mode();
    return mode && !previewing ? mode.questions[mode.state.activeTab] : undefined;
  });
  const currentDraft = $derived.by(() => {
    const mode = options.mode();
    return mode && currentQuestion ? mode.state.drafts[currentQuestion.id] : undefined;
  });
  const allQuestionsComplete = $derived.by(() => {
    const mode = options.mode();
    return mode ? questionnaireIsComplete(mode.state, mode.questions) : false;
  });
  const questionAttachments = $derived(
    currentQuestion && currentDraft?.customSelected
      ? currentDraft.images.map((image: QuestionImage, index: number) => imageAttachment(currentQuestion.id, image, index))
      : [],
  );
  const currentSelectionCount = $derived(questionDraftSelectionCount(currentDraft));
  const displayedAttachments = $derived(options.mode() ? questionAttachments : options.attachments());

  $effect(() => {
    const mode = options.mode();
    const active = !!mode;
    if (active && !modeActive) {
      restoreFocusElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      modeActive = true;
      void tick().then(() => {
        options.form()?.querySelector<HTMLButtonElement>(`[data-question-tab="${mode?.state.activeTab ?? 0}"]`)?.focus();
      });
    } else if (!active && modeActive) {
      modeActive = false;
      const focusTarget = restoreFocusElement;
      restoreFocusElement = null;
      void tick().then(() => {
        if (focusTarget?.isConnected) focusTarget.focus();
        else options.textarea()?.focus();
      });
    }
  });

  function textValue(promptText: string): string {
    if (!options.mode()) return promptText;
    return currentDraft?.customSelected ? currentDraft.customText : "";
  }

  function updateState(state: QuestionComposerMode["state"]): void {
    options.mode()?.onStateChange(state);
  }

  function handleSubmit(): boolean {
    const mode = options.mode();
    if (!mode) return false;
    if (mode.addingImages) return true;
    if (!requiresPreview) {
      if (allQuestionsComplete) mode.onSubmit(mode.state);
      return true;
    }
    if (previewing) {
      if (allQuestionsComplete) mode.onSubmit(mode.state);
      return true;
    }
    const next = advanceQuestionnaire(mode.state, mode.questions);
    if (next !== mode.state) {
      updateState(next);
      focusQuestionContent(next.activeTab);
    }
    return true;
  }

  function updateCustomText(value: string): boolean {
    const mode = options.mode();
    if (!mode || !currentQuestion) return false;
    updateState(updateCustomAnswer(mode.state, currentQuestion.id, value, currentQuestion));
    return true;
  }

  function pasteImages(files: readonly File[]): boolean {
    const mode = options.mode();
    if (!mode || !currentQuestion || !currentDraft?.customSelected) return false;
    void mode.onPasteImages(currentQuestion.id, files);
    return true;
  }

  function chooseImages(): void {
    const mode = options.mode();
    if (mode && currentQuestion) void mode.onChooseImages(currentQuestion.id);
  }

  function chooseChoice(choiceValue: string): void {
    const mode = options.mode();
    if (!mode || !currentQuestion) return;
    const state = currentQuestion.multiple
      ? toggleQuestionChoice(mode.state, currentQuestion, choiceValue)
      : chooseQuestionChoice(mode.state, currentQuestion.id, choiceValue);
    updateState(state);
  }

  async function chooseCustom(): Promise<void> {
    const mode = options.mode();
    if (!mode || !currentQuestion) return;
    const state = currentQuestion.multiple
      ? toggleCustomAnswer(mode.state, currentQuestion)
      : chooseCustomAnswer(mode.state, currentQuestion.id);
    updateState(state);
    if (!state.drafts[currentQuestion.id]?.customSelected) return;
    await tick();
    options.textarea()?.focus();
  }

  function selectTab(index: number): void {
    const mode = options.mode();
    if (!mode) return;
    updateState(selectQuestionnaireTab(mode.state, index, mode.questions));
  }

  function editAnswer(index: number): void {
    const mode = options.mode();
    if (!mode) return;
    updateState(editQuestion(mode.state, index));
    focusQuestionContent(index);
  }

  function focusQuestionContent(index: number): void {
    void tick().then(() => {
      const mode = options.mode();
      if (!mode) return;
      if (index >= mode.questions.length) {
        options.form()?.querySelector<HTMLButtonElement>(`[data-question-tab="${index}"]`)?.focus();
        return;
      }
      options.form()?.querySelector<HTMLButtonElement>("[data-question-choice]")?.focus();
    });
  }

  function handleEscape(event: KeyboardEvent): boolean {
    const mode = options.mode();
    if (!mode || event.key !== "Escape" || event.isComposing) return false;
    event.preventDefault();
    mode.onCancel();
    return true;
  }

  function handleTabKeydown(event: KeyboardEvent, index: number): void {
    const mode = options.mode();
    if (!mode) return;
    const tabCount = mode.questions.length + (requiresPreview ? 1 : 0);
    let nextIndex: number;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabCount;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabCount) % tabCount;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabCount - 1;
    else return;
    event.preventDefault();
    selectTab(nextIndex);
    void tick().then(() => {
      options.form()?.querySelector<HTMLButtonElement>(`[data-question-tab="${nextIndex}"]`)?.focus();
    });
  }

  function selectedChoiceIndex(): number {
    if (!currentQuestion || !currentDraft) return 0;
    const selectedIndex = currentQuestion.choices.findIndex((choice: DesktopQuestion["choices"][number]) => (
      currentDraft.choiceValues.includes(choice.value)
    ));
    if (selectedIndex === -1 && currentDraft.customSelected) return currentQuestion.choices.length;
    return Math.max(0, selectedIndex);
  }

  function chooseAnswerAt(index: number): void {
    const mode = options.mode();
    if (!mode || !currentQuestion) return;
    const choice = currentQuestion.choices[index];
    let state: QuestionComposerMode["state"];
    if (currentQuestion.multiple) {
      state = choice
        ? toggleQuestionChoice(mode.state, currentQuestion, choice.value)
        : toggleCustomAnswer(mode.state, currentQuestion);
    } else {
      state = choice
        ? chooseQuestionChoice(mode.state, currentQuestion.id, choice.value)
        : chooseCustomAnswer(mode.state, currentQuestion.id);
    }
    updateState(state);
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
      options.form()?.querySelector<HTMLButtonElement>(`[data-question-choice="${nextIndex}"]`)?.focus();
    });
  }

  function removeDisplayedAttachment(id: string): void {
    const mode = options.mode();
    if (!mode || !currentQuestion) {
      options.removeAttachment(id);
      return;
    }
    const imageIndex = Number(id.split(":").at(-1));
    if (Number.isInteger(imageIndex)) updateState(removeQuestionImage(mode.state, currentQuestion.id, imageIndex));
  }

  function openDisplayedAttachment(attachment: Attachment): void {
    const mode = options.mode();
    if (!mode || !currentDraft) {
      options.openAttachment(attachment);
      return;
    }
    const imageIndex = Number(attachment.id.split(":").at(-1));
    const image = currentDraft.images[imageIndex];
    if (image) mode.onOpenImage(image);
  }

  function answerLabel(question: DesktopQuestion): string {
    const mode = options.mode();
    if (!mode) return "Not answered";
    const draft = mode.state.drafts[question.id];
    if (!draft || !questionDraftIsComplete(draft, question)) return "Not answered";
    if (question.multiple) {
      const labels = question.choices
        .filter((choice: DesktopQuestion["choices"][number]) => draft.choiceValues.includes(choice.value))
        .map((choice: DesktopQuestion["choices"][number]) => choice.label);
      if (draft.customSelected) labels.push(customAnswerLabel(draft.customText, draft.images.length));
      return labels.join(", ");
    }
    if (!draft.customSelected) {
      return question.choices.find((choice: DesktopQuestion["choices"][number]) => (
        draft.choiceValues.includes(choice.value)
      ))?.label ?? "Not answered";
    }
    return customAnswerLabel(draft.customText, draft.images.length);
  }

  function currentDraftIsComplete(): boolean {
    return questionDraftIsComplete(currentDraft, currentQuestion);
  }

  return {
    get requiresPreview() { return requiresPreview; },
    get previewing() { return previewing; },
    get currentQuestion() { return currentQuestion; },
    get currentDraft() { return currentDraft; },
    get allQuestionsComplete() { return allQuestionsComplete; },
    get currentSelectionCount() { return currentSelectionCount; },
    get displayedAttachments() { return displayedAttachments; },
    textValue,
    handleSubmit,
    updateCustomText,
    pasteImages,
    chooseImages,
    chooseChoice,
    chooseCustom,
    selectTab,
    editAnswer,
    handleEscape,
    handleTabKeydown,
    selectedChoiceIndex,
    handleChoiceKeydown,
    removeDisplayedAttachment,
    openDisplayedAttachment,
    answerLabel,
    currentDraftIsComplete,
  };
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

export type PromptComposerQuestionnaireController = ReturnType<typeof createPromptComposerQuestionnaireController>;
