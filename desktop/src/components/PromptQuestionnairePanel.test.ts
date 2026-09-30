import { describe, expect, it } from "vitest";
import composerSource from "./PromptComposer.svelte?raw";
import panelSource from "./PromptQuestionnairePanel.svelte?raw";
import controllerSource from "./prompt-composer-questionnaire-controller.svelte.ts?raw";

describe("Prompt questionnaire preview policy", () => {
  it("wraps choice and preview text instead of inheriting button nowrap", () => {
    const wrappingText = 'class="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]"';
    expect(panelSource.split(wrappingText)).toHaveLength(3);
    expect(panelSource).toContain("whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground\">{currentQuestion.prompt}");
  });

  it("submits a single-question questionnaire without an answer preview", () => {
    expect(controllerSource).toContain("(options.mode()?.questions.length ?? 0) > 1");
    expect(controllerSource).toContain("if (!requiresPreview) {");
    expect(controllerSource).toContain("if (allQuestionsComplete) mode.onSubmit(mode.state);");
    expect(panelSource).toContain("{#if requiresPreview}");
    expect(composerSource).toContain("Submit answer");
  });

  it("retains Preview for questionnaires with multiple questions", () => {
    expect(panelSource).toContain(">Preview</button>");
    expect(composerSource).toContain("questionnaireController.previewing");
    expect(composerSource).toContain("Submit answers");
  });
});
