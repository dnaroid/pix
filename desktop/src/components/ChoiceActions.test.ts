import { describe, expect, it } from "vitest";
import choiceSource from "./ChoiceActions.svelte?raw";
import markdownSource from "./MarkdownText.svelte?raw";
import transcriptSource from "./TranscriptPane.svelte?raw";

describe("ChoiceActions quick-choice block", () => {
  it("starts from the model's [x] recommendations without tracking later prop changes", () => {
    expect(choiceSource).toContain("untrack(() => actions.items.flatMap((item, index) => item.checked ? [index] : []))");
  });

  it("accepts input only while active, idle and not yet submitted", () => {
    expect(choiceSource).toContain("const enabled = $derived(active && !submitting && !submitted);");
    expect(choiceSource).toContain("if (!enabled) return;");
    expect(choiceSource).toContain("if (!enabled || !selected.length) return;");
    expect(choiceSource).toContain("disabled={!enabled || !selected.length}");
    expect(choiceSource).toContain("{#if active && !submitted}");
  });

  it("exposes accessible checkboxes and a language-neutral counter", () => {
    expect(choiceSource).toContain('role="checkbox"');
    expect(choiceSource).toContain("aria-checked={isSelected}");
    expect(choiceSource).toContain("{selected.length} / {actions.items.length}");
    expect(choiceSource).not.toMatch(/selected ·|type your own reply/);
  });

  it("sends the formatted selection and surfaces submission errors", () => {
    expect(choiceSource).toContain("await onSubmit(choiceActionsPrompt(actions.submitLabel, actions.items, selected));");
    expect(choiceSource).toContain("submitted = true;");
    expect(choiceSource).toContain('role="alert"');
  });

  it("spans the chat column", () => {
    expect(choiceSource).toContain('class="my-3 w-full');
    expect(choiceSource).not.toContain("max-w-2xl");
  });

  it("is remounted per block content and activated only for the latest settled reply", () => {
    expect(markdownSource).toContain("{#key JSON.stringify(segment.actions)}");
    expect(transcriptSource).toContain("promptRunning ? undefined : latestAssistantMessageId(displayItems)");
    expect(transcriptSource).toContain("choiceActionsActive={item.id === choiceActionsMessageId}");
  });
});
