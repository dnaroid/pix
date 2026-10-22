import { describe, expect, it } from "vitest";
import composerSource from "./PromptComposer.svelte?raw";
import panelSource from "./PromptQuestionnairePanel.svelte?raw";
import controllerSource from "./prompt-composer-questionnaire-controller.svelte.ts?raw";

describe("Prompt questionnaire preview policy", () => {
  it("wraps choice and preview text instead of inheriting button nowrap", () => {
    const wrappingText = 'class="min-w-0 flex-1 [overflow-wrap:anywhere]"';
    expect(panelSource.split(wrappingText)).toHaveLength(3);
    // pre-wrap belongs on text spans only: on the wrapper it renders template
    // newlines between label/description as tall blank gaps.
    expect(panelSource).not.toContain("flex-1 whitespace-pre-wrap");
    expect(panelSource).toContain('font-medium whitespace-pre-wrap text-foreground">{choice.label}');
    expect(panelSource).toContain("leading-snug whitespace-pre-wrap text-muted-foreground\">{choice.description}");
    expect(panelSource).toContain('font-semibold whitespace-pre-wrap text-foreground">{question.label}');
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

  it("offers a state-rotating collapse toggle that hides the body and footer", () => {
    expect(panelSource).toContain("data-question-collapse-toggle");
    expect(panelSource).toContain("aria-expanded={!collapsed}");
    expect(panelSource).toMatch(/collapsed \? "-rotate-90" : "rotate-90"/);
    expect(panelSource).toContain("hidden={collapsed}");
    expect(composerSource).toContain("hidden={!!questionMode && questionCollapsed}");
    expect(composerSource).toContain("if (questionCollapsed) return;");
  });
});
