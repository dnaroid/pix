import { describe, expect, it, vi } from "vitest";
import composerSource from "./PromptComposer.svelte?raw";
import { createPromptComposerQuestionnaireController } from "./prompt-composer-questionnaire-controller.svelte";
import {
  chooseQuestionChoice,
  createQuestionnaireState,
  type DesktopQuestion,
  type QuestionComposerMode,
} from "../lib/question";

const question: DesktopQuestion = {
  id: "scope", label: "Scope", prompt: "Which scope?",
  choices: [{ value: "small", label: "Small" }, { value: "large", label: "Large" }],
};

function setup({ count = 1, complete = true, preview = false, addingImages = false } = {}) {
  const questions = Array.from({ length: count }, (_, index) => ({ ...question, id: `q${index}` }));
  let state = createQuestionnaireState(questions);
  if (complete) {
    for (const item of questions) state = chooseQuestionChoice(state, item.id, "small");
  }
  if (preview) state = { ...state, activeTab: count };
  const mode = {
    questions, state, addingImages,
    onStateChange: vi.fn(), onSubmit: vi.fn(),
  } as unknown as QuestionComposerMode;
  const controller = createPromptComposerQuestionnaireController({
    mode: () => mode, form: () => undefined, textarea: () => undefined,
    attachments: () => [], removeAttachment: vi.fn(), openAttachment: vi.fn(),
  });
  return { mode, controller };
}

function key(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: "Enter", shiftKey: false, isComposing: false, repeat: false,
    preventDefault: vi.fn(), stopPropagation: vi.fn(), ...overrides,
  } as unknown as KeyboardEvent;
}

describe("questionnaire keyboard", () => {
  it("captures Enter before focused buttons activate", () => {
    expect(composerSource).toContain("onkeydowncapture={questionnaireController.handleKeydown}");
    const { mode, controller } = setup();
    const event = key();
    controller.handleKeydown(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(mode.onSubmit).toHaveBeenCalledWith(mode.state);
    expect(mode.onStateChange).not.toHaveBeenCalled();
    expect(mode.state.drafts.q0?.choiceValues).toEqual(["small"]);
  });

  it("advances complete answers without changing choices", () => {
    const { mode, controller } = setup({ count: 2 });
    controller.handleKeydown(key());
    expect(mode.onStateChange).toHaveBeenCalledWith({ ...mode.state, activeTab: 1 });
    expect(mode.onSubmit).not.toHaveBeenCalled();
  });

  it("submits from Preview rather than activating its Edit buttons", () => {
    const { mode, controller } = setup({ count: 2, preview: true });
    controller.handleKeydown(key());
    expect(mode.onSubmit).toHaveBeenCalledWith(mode.state);
    expect(mode.onStateChange).not.toHaveBeenCalled();
  });

  it.each([
    { complete: false }, { count: 2, complete: false }, { addingImages: true },
  ])("blocks incomplete answers or image ingestion: %j", (options) => {
    const { mode, controller } = setup(options);
    controller.handleKeydown(key());
    expect(mode.onSubmit).not.toHaveBeenCalled();
    expect(mode.onStateChange).not.toHaveBeenCalled();
  });

  it.each([{ key: " " }, { shiftKey: true }, { isComposing: true }])(
    "preserves native Space, newlines and composition: %j", (overrides) => {
      const { mode, controller } = setup();
      const event = key(overrides);
      controller.handleKeydown(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
      expect(mode.onSubmit).not.toHaveBeenCalled();
    },
  );

  it("suppresses held Enter without repeating the action", () => {
    const { mode, controller } = setup();
    const event = key({ repeat: true });
    controller.handleKeydown(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(mode.onSubmit).not.toHaveBeenCalled();
  });
});
