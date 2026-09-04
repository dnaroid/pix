import { describe, expect, it } from "vitest";
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import {
  addQuestionImages,
  advanceQuestionnaire,
  chooseCustomAnswer,
  chooseQuestionChoice,
  createQuestionAcceptResponse,
  createQuestionSelections,
  createQuestionnaireState,
  editQuestion,
  parseQuestionElicitation,
  questionnaireIsComplete,
  retreatQuestionnaire,
  selectQuestionnaireTab,
  toggleCustomAnswer,
  toggleQuestionChoice,
  updateCustomAnswer,
  type DesktopQuestion,
} from "./question";

const QUESTIONS: DesktopQuestion[] = [
  {
    id: "scope",
    label: "Scope",
    prompt: "Which scope?",
    choices: [
      { value: "small", label: "Small", description: "Quick change" },
      { value: "large", label: "Large", description: "" },
    ],
  },
  {
    id: "delivery",
    label: "Delivery",
    prompt: "When should it ship?",
    choices: [
      { value: "now", label: "Now" },
      { value: "later", label: "Later" },
    ],
  },
];

const MULTI_QUESTION: DesktopQuestion = {
  id: "areas",
  label: "Areas",
  prompt: "Which areas?",
  choices: [
    { value: "api", label: "API" },
    { value: "ui", label: "UI" },
    { value: "docs", label: "Docs" },
  ],
  multiple: true,
  minSelections: 2,
  maxSelections: 3,
};

function request(overrides: Record<string, unknown> = {}): CreateElicitationRequest {
  return {
    mode: "_pix.question",
    message: "Answer the agent's questions",
    version: 1,
    questions: QUESTIONS,
    ...overrides,
  } as unknown as CreateElicitationRequest;
}

describe("Desktop question elicitation", () => {
  it("parses a private normalized questionnaire", () => {
    expect(parseQuestionElicitation(request())).toEqual({
      message: "Answer the agent's questions",
      questions: QUESTIONS,
    });
  });

  it("rejects malformed or non-question elicitations", () => {
    expect(parseQuestionElicitation({ mode: "form" } as CreateElicitationRequest)).toBeNull();
    expect(parseQuestionElicitation(request({ version: 2 }))).toBeNull();
    expect(parseQuestionElicitation(request({ questions: [{ ...QUESTIONS[0], id: "Scope" }] }))).toBeNull();
    expect(parseQuestionElicitation(request({
      questions: [{
        ...QUESTIONS[0],
        choices: [{ value: "same", label: "One" }, { value: "SAME", label: "Two" }],
      }],
    }))).toBeNull();
    expect(parseQuestionElicitation(request({
      questions: [{ ...MULTI_QUESTION, minSelections: 4, maxSelections: 3 }],
    }))).toBeNull();
  });

  it("parses normalized multi-select questions", () => {
    expect(parseQuestionElicitation(request({ questions: [MULTI_QUESTION] }))).toEqual({
      message: "Answer the agent's questions",
      questions: [MULTI_QUESTION],
    });
  });

  it("requires the current answer before advancing through question and Preview tabs", () => {
    let state = createQuestionnaireState(QUESTIONS);
    expect(advanceQuestionnaire(state, QUESTIONS)).toBe(state);

    state = chooseQuestionChoice(state, "scope", "large");
    state = advanceQuestionnaire(state, QUESTIONS);
    expect(state.activeTab).toBe(1);

    state = chooseCustomAnswer(state, "delivery");
    state = updateCustomAnswer(state, "delivery", "After QA");
    state = advanceQuestionnaire(state, QUESTIONS);
    expect(state.activeTab).toBe(QUESTIONS.length);
    expect(questionnaireIsComplete(state, QUESTIONS)).toBe(true);

    state = retreatQuestionnaire(state);
    expect(state.activeTab).toBe(1);
    state = editQuestion(state, 0);
    expect(state.activeTab).toBe(0);
  });

  it("allows direct tab navigation including Preview", () => {
    const state = createQuestionnaireState(QUESTIONS);
    expect(selectQuestionnaireTab(state, 1, QUESTIONS).activeTab).toBe(1);
    expect(selectQuestionnaireTab(state, QUESTIONS.length, QUESTIONS).activeTab).toBe(QUESTIONS.length);
    expect(selectQuestionnaireTab(state, -1, QUESTIONS)).toBe(state);
    expect(selectQuestionnaireTab(state, QUESTIONS.length + 1, QUESTIONS)).toBe(state);
    expect(questionnaireIsComplete(state, QUESTIONS)).toBe(false);
  });

  it("serializes predefined and image-only custom answers", () => {
    let state = createQuestionnaireState(QUESTIONS);
    state = chooseQuestionChoice(state, "scope", "small");
    state = chooseCustomAnswer(state, "delivery");
    state = addQuestionImages(state, "delivery", [{
      type: "image",
      data: "aW1hZ2U=",
      mimeType: "image/png",
      name: "shot.png",
      size: 5,
    }]);

    const selections = createQuestionSelections(state, QUESTIONS);
    expect(selections).toEqual([
      { id: "scope", choiceValue: "small" },
      {
        id: "delivery",
        customText: "",
        images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
      },
    ]);
    expect(createQuestionAcceptResponse(selections!)).toEqual({
      action: "accept",
      content: { value: JSON.stringify({ version: 1, selections }) },
    });
  });

  it("does not serialize an unknown predefined choice", () => {
    let state = createQuestionnaireState(QUESTIONS);
    state = chooseQuestionChoice(state, "scope", "invented");
    state = updateCustomAnswer(state, "delivery", "After QA");
    expect(createQuestionSelections(state, QUESTIONS)).toBeNull();
  });

  it("rejects empty custom-answer images before they can complete a draft", () => {
    let state = chooseCustomAnswer(createQuestionnaireState(QUESTIONS), "scope");
    state = addQuestionImages(state, "scope", [{
      type: "image",
      data: "",
      mimeType: "image/png",
      name: "empty.png",
      size: 0,
    }], QUESTIONS[0]);
    expect(state.drafts.scope?.images).toEqual([]);
    expect(createQuestionSelections(state, QUESTIONS)).toBeNull();
  });

  it("toggles bounded multi-select choices and an additive custom answer", () => {
    const questions = [MULTI_QUESTION];
    let state = createQuestionnaireState(questions);
    state = toggleQuestionChoice(state, MULTI_QUESTION, "api");
    expect(questionnaireIsComplete(state, questions)).toBe(false);
    state = toggleQuestionChoice(state, MULTI_QUESTION, "ui");
    expect(questionnaireIsComplete(state, questions)).toBe(true);

    state = toggleCustomAnswer(state, MULTI_QUESTION);
    expect(questionnaireIsComplete(state, questions)).toBe(false);
    state = updateCustomAnswer(state, "areas", "Other", MULTI_QUESTION);
    expect(questionnaireIsComplete(state, questions)).toBe(true);

    const atLimit = toggleQuestionChoice(state, MULTI_QUESTION, "docs");
    expect(atLimit).toBe(state);
    expect(createQuestionSelections(state, questions)).toEqual([{
      id: "areas",
      choiceValues: ["api", "ui"],
      customText: "Other",
    }]);

    state = toggleQuestionChoice(state, MULTI_QUESTION, "api");
    expect(createQuestionSelections(state, questions)).toEqual([{
      id: "areas",
      choiceValues: ["ui"],
      customText: "Other",
    }]);
  });
});
