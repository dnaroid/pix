import { describe, expect, it } from "vitest";
import choiceSource from "./ChoiceActions.svelte?raw";
import markdownSource from "./MarkdownText.svelte?raw";
import transcriptSource from "./TranscriptPane.svelte?raw";

describe("ChoiceActions quick-choice block", () => {
  it("restores block state without tracking later prop changes", () => {
    expect(choiceSource).toContain("untrack(() => choiceActionsStateCache.get(stateScope, blockIndex, actions))");
  });

  it("keeps unsent checklists usable after they expire; reply buttons only while active", () => {
    expect(choiceSource).toContain("const enabled = $derived(!state.submitting && !state.submitted);");
    expect(choiceSource).toContain("const buttonsEnabled = $derived(active && enabled);");
    expect(choiceSource).toContain("if (!enabled) return;");
    expect(choiceSource).toContain("if (!state.selected.length) return;");
    expect(choiceSource).toContain("disabled={!enabled || !showSelection || !state.selected.length}");
    expect(choiceSource).toContain("{#if !state.submitted && (active || state.edited)}");
  });

  it("exposes accessible checkboxes and a language-neutral counter", () => {
    expect(choiceSource).toContain('role="checkbox"');
    expect(choiceSource).toContain("aria-checked={isSelected}");
    expect(choiceSource).toContain("{state.selected.length} / {actions.items.length}");
    expect(choiceSource).not.toMatch(/selected ·|type your own reply/);
  });

  it("hides model-default checks on an expired block until the user edits it", () => {
    expect(choiceSource).toContain("const showSelection = $derived(active || state.submitted || state.edited);");
    expect(choiceSource).toContain("const isSelected = showSelection && state.selected.includes(index)");
    expect(choiceSource).toContain("const base = showSelection ? state.selected : [];");
  });

  it("dims only unselected text on expired or locked blocks", () => {
    expect(choiceSource).toContain('(!enabled || !active) && !isSelected && "opacity-60"');
    expect(choiceSource).toContain('(!enabled || !active) && "opacity-60"');
    expect(choiceSource).toContain("aria-disabled={!enabled || undefined}");
  });

  it("keeps option labels selectable: rows are not buttons and selecting text does not toggle", () => {
    expect(choiceSource).toContain('"select-text min-w-0 flex-1');
    expect(choiceSource).not.toMatch(/<button[^>]*\n[^<]*role="checkbox"/);
    expect(choiceSource).toMatch(/<div\n[^<]*role="checkbox"\n\s*tabindex=\{enabled \? 0 : -1\}/);
    expect(choiceSource).toContain("!selectingText(event)");
    expect(choiceSource).toContain('if (event.key !== " " && event.key !== "Enter") return;');
  });

  it("sends the formatted selection and surfaces submission errors", () => {
    expect(choiceSource).toContain("await onSubmit(button !== undefined ? (actions.items[button]!.prompt ?? actions.items[button]!.label) : choiceActionsPrompt(actions.submitLabel, actions.items, state.selected));");
    expect(choiceSource).toContain("title={item.prompt}");
    expect(choiceSource).toContain("state.submitted = true;");
    expect(choiceSource).toContain('role="alert"');
  });

  it("spans the chat column", () => {
    expect(choiceSource).toContain('class="my-3 w-full');
    expect(choiceSource).not.toContain("max-w-2xl");
  });

  it("is remounted per block content and activated only for the latest settled reply", () => {
    expect(markdownSource).toContain("{#key JSON.stringify([choiceActionsScope, segment.actions])}");
    expect(markdownSource).toContain("stateScope={choiceActionsScope} blockIndex={index}");
    expect(transcriptSource).toContain("choiceActionsScope={activeSessionId ? JSON.stringify([activeSessionId, item.id]) : undefined}");
    expect(transcriptSource).toContain("promptRunning ? undefined : latestChoiceActionsMessageId(displayItems)");
    expect(transcriptSource).toContain("choiceActionsActive={item.id === choiceActionsMessageId}");
  });

  it("renders reply buttons that send their label once, then lock", () => {
    expect(choiceSource).toContain("{#if actions.buttons}");
    expect(choiceSource).toContain("onclick={() => submit(index)}");
    expect(choiceSource).toContain("if (button !== undefined) state.selected = [button];");
    expect(choiceSource).toContain("disabled={!buttonsEnabled}");
    expect(choiceSource).toContain("aria-pressed={state.submitted ? pressed : undefined}");
  });
});
