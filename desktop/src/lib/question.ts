import type { CreateElicitationRequest, CreateElicitationResponse } from "@agentclientprotocol/sdk";

export const PIX_QUESTION_ELICITATION_MODE = "_pix.question";
export const MAX_QUESTION_IMAGES = 10;
export const MAX_QUESTION_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_QUESTION_IMAGE_BYTES_TOTAL = 50 * 1024 * 1024;

export interface QuestionChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface DesktopQuestion {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
  readonly choices: QuestionChoice[];
  readonly multiple?: true;
  readonly minSelections?: number;
  readonly maxSelections?: number;
}

export interface QuestionImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
  readonly name: string;
  readonly size: number;
}

export interface QuestionDraft {
  readonly choiceValues: string[];
  readonly customSelected: boolean;
  readonly customText: string;
  readonly images: QuestionImage[];
}

export interface QuestionnaireState {
  /** Zero-based question index, or questions.length for the Preview tab. */
  readonly activeTab: number;
  readonly drafts: Record<string, QuestionDraft>;
}

export interface ParsedQuestionElicitation {
  readonly message: string;
  readonly questions: DesktopQuestion[];
}

export interface QuestionComposerMode {
  readonly message: string;
  readonly questions: DesktopQuestion[];
  readonly state: QuestionnaireState;
  readonly addingImages: boolean;
  readonly onStateChange: (state: QuestionnaireState) => void;
  readonly onSubmit: (state: QuestionnaireState) => void;
  readonly onCancel: () => void;
  readonly onChooseImages: (questionId: string) => void | Promise<void>;
  readonly onPasteImages: (questionId: string, files: readonly File[]) => void | Promise<void>;
  readonly onOpenImage: (image: QuestionImage) => void;
}

export type QuestionSelection =
  | { readonly id: string; readonly choiceValue: string }
  | {
      readonly id: string;
      readonly customText: string;
      readonly images?: Array<{ readonly type: "image"; readonly data: string; readonly mimeType: string }>;
    }
  | {
      readonly id: string;
      readonly choiceValues: string[];
      readonly customText?: string;
      readonly images?: Array<{ readonly type: "image"; readonly data: string; readonly mimeType: string }>;
    };

export function parseQuestionElicitation(request: CreateElicitationRequest): ParsedQuestionElicitation | null {
  const raw = request as unknown as Record<string, unknown>;
  if (raw.mode !== PIX_QUESTION_ELICITATION_MODE || raw.version !== 1 || !Array.isArray(raw.questions)) return null;
  if (raw.questions.length < 1 || raw.questions.length > 5 || typeof raw.message !== "string") return null;

  const ids = new Set<string>();
  const labels = new Set<string>();
  const questions: DesktopQuestion[] = [];
  for (const rawQuestion of raw.questions) {
    if (!isRecord(rawQuestion) || !hasOnlyKeys(rawQuestion, ["id", "label", "prompt", "choices", "multiple", "minSelections", "maxSelections"])) return null;
    const id = trimmedString(rawQuestion.id);
    const label = trimmedString(rawQuestion.label);
    const prompt = trimmedString(rawQuestion.prompt);
    if (!id || !label || !prompt || !/^[a-z][a-z0-9_-]*$/.test(id) || /[\r\n]/.test(label)) return null;
    const normalizedLabel = label.toLocaleLowerCase();
    if (ids.has(id) || labels.has(normalizedLabel) || !Array.isArray(rawQuestion.choices)) return null;
    if (rawQuestion.choices.length < 2 || rawQuestion.choices.length > 5) return null;
    ids.add(id);
    labels.add(normalizedLabel);

    const values = new Set<string>();
    const choiceLabels = new Set<string>();
    const choices: QuestionChoice[] = [];
    for (const rawChoice of rawQuestion.choices) {
      if (!isRecord(rawChoice) || !hasOnlyKeys(rawChoice, ["value", "label", "description"])) return null;
      const value = trimmedString(rawChoice.value);
      const choiceLabel = trimmedString(rawChoice.label);
      const description = rawChoice.description === undefined
        ? undefined
        : typeof rawChoice.description === "string" ? rawChoice.description : null;
      const normalizedValue = value?.toLocaleLowerCase();
      const normalizedChoiceLabel = choiceLabel?.toLocaleLowerCase();
      if (
        !value || !choiceLabel || description === null
        || value === "__question_custom_answer__"
        || normalizedChoiceLabel === "something else…"
        || values.has(normalizedValue!) || choiceLabels.has(normalizedChoiceLabel!)
      ) return null;
      values.add(normalizedValue!);
      choiceLabels.add(normalizedChoiceLabel!);
      choices.push({ value, label: choiceLabel, ...(description !== undefined ? { description } : {}) });
    }
    const multiple = rawQuestion.multiple === true;
    if (rawQuestion.multiple !== undefined && !multiple) return null;
    if (!multiple && (rawQuestion.minSelections !== undefined || rawQuestion.maxSelections !== undefined)) return null;
    const minSelections = positiveInteger(rawQuestion.minSelections);
    const maxSelections = positiveInteger(rawQuestion.maxSelections);
    if (multiple && (
      minSelections === null || maxSelections === null
      || minSelections > maxSelections || maxSelections > choices.length + 1
    )) return null;
    questions.push({
      id,
      label,
      prompt,
      choices,
      ...(multiple ? { multiple: true, minSelections: minSelections!, maxSelections: maxSelections! } : {}),
    });
  }
  return { message: raw.message, questions };
}

export function createQuestionnaireState(questions: readonly DesktopQuestion[]): QuestionnaireState {
  return {
    activeTab: 0,
    drafts: Object.fromEntries(questions.map((question) => [question.id, emptyDraft()])),
  };
}

export function chooseQuestionChoice(
  state: QuestionnaireState,
  questionId: string,
  choiceValue: string,
): QuestionnaireState {
  const draft = state.drafts[questionId];
  if (!draft) return state;
  return updateDraft(state, questionId, { ...draft, choiceValues: [choiceValue], customSelected: false });
}

export function chooseCustomAnswer(state: QuestionnaireState, questionId: string): QuestionnaireState {
  const draft = state.drafts[questionId];
  if (!draft) return state;
  return updateDraft(state, questionId, { ...draft, choiceValues: [], customSelected: true });
}

export function toggleQuestionChoice(
  state: QuestionnaireState,
  question: DesktopQuestion,
  choiceValue: string,
): QuestionnaireState {
  if (!question.multiple) return chooseQuestionChoice(state, question.id, choiceValue);
  const draft = state.drafts[question.id];
  if (!draft || !question.choices.some((choice) => choice.value === choiceValue)) return state;
  const selected = draft.choiceValues.includes(choiceValue);
  if (!selected && questionDraftSelectionCount(draft) >= (question.maxSelections ?? question.choices.length + 1)) return state;
  const selectedValues = new Set(selected
    ? draft.choiceValues.filter((value) => value !== choiceValue)
    : [...draft.choiceValues, choiceValue]);
  return updateDraft(state, question.id, {
    ...draft,
    choiceValues: question.choices.filter((choice) => selectedValues.has(choice.value)).map((choice) => choice.value),
  });
}

export function toggleCustomAnswer(state: QuestionnaireState, question: DesktopQuestion): QuestionnaireState {
  if (!question.multiple) return chooseCustomAnswer(state, question.id);
  const draft = state.drafts[question.id];
  if (!draft) return state;
  if (!draft.customSelected && questionDraftSelectionCount(draft) >= (question.maxSelections ?? question.choices.length + 1)) return state;
  return updateDraft(state, question.id, { ...draft, customSelected: !draft.customSelected });
}

export function updateCustomAnswer(
  state: QuestionnaireState,
  questionId: string,
  customText: string,
  question?: DesktopQuestion,
): QuestionnaireState {
  const draft = state.drafts[questionId];
  if (!draft) return state;
  if (question?.multiple && !draft.customSelected && questionDraftSelectionCount(draft) >= (question.maxSelections ?? question.choices.length + 1)) return state;
  return updateDraft(state, questionId, {
    ...draft,
    ...(question?.multiple ? {} : { choiceValues: [] }),
    customSelected: true,
    customText,
  });
}

export function addQuestionImages(
  state: QuestionnaireState,
  questionId: string,
  images: readonly QuestionImage[],
  question?: DesktopQuestion,
): QuestionnaireState {
  const draft = state.drafts[questionId];
  if (!draft || images.length === 0) return state;
  const validImages = images.filter(questionImageIsValid);
  if (validImages.length === 0) return state;
  if (question?.multiple && !draft.customSelected && questionDraftSelectionCount(draft) >= (question.maxSelections ?? question.choices.length + 1)) return state;
  return updateDraft(state, questionId, {
    ...draft,
    ...(question?.multiple ? {} : { choiceValues: [] }),
    customSelected: true,
    images: [...draft.images, ...validImages],
  });
}

export function removeQuestionImage(
  state: QuestionnaireState,
  questionId: string,
  imageIndex: number,
): QuestionnaireState {
  const draft = state.drafts[questionId];
  if (!draft) return state;
  return updateDraft(state, questionId, {
    ...draft,
    images: draft.images.filter((_image, index) => index !== imageIndex),
  });
}

export function questionDraftSelectionCount(draft: QuestionDraft | undefined): number {
  return draft ? draft.choiceValues.length + (draft.customSelected ? 1 : 0) : 0;
}

export function questionDraftIsComplete(draft: QuestionDraft | undefined, question?: DesktopQuestion): boolean {
  if (!draft) return false;
  if (draft.images.some((image) => !questionImageIsValid(image))) return false;
  const customComplete = !draft.customSelected || !!draft.customText.trim() || draft.images.length > 0;
  if (!customComplete) return false;
  if (!question?.multiple) {
    if (draft.choiceValues.length === 1 && !draft.customSelected) {
      return !question || question.choices.some((choice) => choice.value === draft.choiceValues[0]);
    }
    return draft.choiceValues.length === 0 && draft.customSelected;
  }
  const validChoices = new Set(question.choices.map((choice) => choice.value));
  if (new Set(draft.choiceValues).size !== draft.choiceValues.length || draft.choiceValues.some((value) => !validChoices.has(value))) return false;
  const count = questionDraftSelectionCount(draft);
  return count >= (question.minSelections ?? 1) && count <= (question.maxSelections ?? question.choices.length + 1);
}

export function advanceQuestionnaire(
  state: QuestionnaireState,
  questions: readonly DesktopQuestion[],
): QuestionnaireState {
  const question = questions[state.activeTab];
  if (!question || !questionDraftIsComplete(state.drafts[question.id], question)) return state;
  return { ...state, activeTab: Math.min(state.activeTab + 1, questions.length) };
}

export function retreatQuestionnaire(state: QuestionnaireState): QuestionnaireState {
  return state.activeTab > 0 ? { ...state, activeTab: state.activeTab - 1 } : state;
}

export function editQuestion(state: QuestionnaireState, index: number): QuestionnaireState {
  return { ...state, activeTab: index };
}

export function selectQuestionnaireTab(
  state: QuestionnaireState,
  index: number,
  questions: readonly DesktopQuestion[],
): QuestionnaireState {
  if (!Number.isInteger(index) || index < 0 || index > questions.length) return state;
  return { ...state, activeTab: index };
}

export function questionnaireIsComplete(
  state: QuestionnaireState,
  questions: readonly DesktopQuestion[],
): boolean {
  return questions.every((question) => questionDraftIsComplete(state.drafts[question.id], question));
}

export function createQuestionSelections(
  state: QuestionnaireState,
  questions: readonly DesktopQuestion[],
): QuestionSelection[] | null {
  if (
    totalQuestionImageCount(state) > MAX_QUESTION_IMAGES
    || totalQuestionImageBytes(state) > MAX_QUESTION_IMAGE_BYTES_TOTAL
  ) return null;
  const selections: QuestionSelection[] = [];
  for (const question of questions) {
    const draft = state.drafts[question.id];
    if (!draft || !questionDraftIsComplete(draft, question)) return null;
    if (question.multiple) {
      selections.push({
        id: question.id,
        choiceValues: [...draft.choiceValues],
        ...(draft.customSelected ? { customText: draft.customText } : {}),
        ...(draft.customSelected && draft.images.length > 0 ? {
          images: draft.images.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType })),
        } : {}),
      });
      continue;
    }
    if (!draft.customSelected) {
      selections.push({ id: question.id, choiceValue: draft.choiceValues[0]! });
    } else {
      selections.push({
        id: question.id,
        customText: draft.customText,
        ...(draft.images.length > 0 ? {
          images: draft.images.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType })),
        } : {}),
      });
    }
  }
  return selections;
}

export function createQuestionAcceptResponse(selections: readonly QuestionSelection[]): CreateElicitationResponse {
  return {
    action: "accept",
    content: { value: JSON.stringify({ version: 1, selections }) },
  };
}

export function totalQuestionImageCount(state: QuestionnaireState): number {
  return Object.values(state.drafts).reduce((total, draft) => total + draft.images.length, 0);
}

export function totalQuestionImageBytes(state: QuestionnaireState): number {
  return Object.values(state.drafts).reduce(
    (total, draft) => total + draft.images.reduce((subtotal, image) => subtotal + image.size, 0),
    0,
  );
}

function emptyDraft(): QuestionDraft {
  return { choiceValues: [], customSelected: false, customText: "", images: [] };
}

function updateDraft(state: QuestionnaireState, questionId: string, draft: QuestionDraft): QuestionnaireState {
  return { ...state, drafts: { ...state.drafts, [questionId]: draft } };
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function questionImageIsValid(image: QuestionImage): boolean {
  if (image.type !== "image" || !/^image\/[a-z0-9.+-]+$/i.test(image.mimeType)) return false;
  if (!image.data || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return false;
  const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
  const decodedBytes = (image.data.length / 4) * 3 - padding;
  return decodedBytes > 0 && decodedBytes <= MAX_QUESTION_IMAGE_BYTES && image.size === decodedBytes;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
