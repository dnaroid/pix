import { describe, expect, it } from "vitest";
import { createPromptComposerTextareaController } from "./prompt-composer-textarea-controller.svelte";
import promptComposerSource from "./PromptComposer.svelte?raw";

function layoutCountingTextarea() {
  const counts = { layoutReads: 0 };
  const textarea = {
    value: "hello",
    selectionStart: 5,
    selectionEnd: 5,
    style: {} as Record<string, string>,
    get scrollHeight() { counts.layoutReads += 1; return 40; },
    get offsetHeight() { counts.layoutReads += 1; return 40; },
  };
  return { counts, textarea: textarea as unknown as HTMLTextAreaElement };
}

describe("prompt composer textarea controller", () => {
  it("does not force a synchronous layout on input; the draft effect resizes once per frame", () => {
    const { counts, textarea } = layoutCountingTextarea();
    const controller = createPromptComposerTextareaController({
      textarea: () => textarea,
      ghostLayer: () => undefined,
      composerForm: () => undefined,
      promptText: () => textarea.value,
      setPromptText: () => {},
      activeSessionId: () => null,
      attachmentsCount: () => 0,
      editorMode: () => true,
      questionMode: () => false,
      autocompleteEnabled: () => false,
      ready: () => true,
      requestAutocomplete: async () => "",
    });

    controller.handleInput(textarea);

    expect(counts.layoutReads).toBe(0);
    expect(textarea.style.height).toBeUndefined();
    expect(controller.selectionStart).toBe(5);
    controller.dispose();

    // The deferred resize stays keyed to the draft text, so typing and paste still size the textarea.
    const draftEffect = promptComposerSource.slice(promptComposerSource.indexOf("    promptText;\n"));
    expect(draftEffect.slice(0, draftEffect.indexOf("$effect(() => () =>"))).toContain("requestAnimationFrame(textareaController.resize)");
  });
});
