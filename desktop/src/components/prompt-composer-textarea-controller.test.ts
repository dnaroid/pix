import { describe, expect, it, vi } from "vitest";
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
  it("waits for the response to finish and cancels next-message prediction on a new turn", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    let running = true;
    let signal!: AbortSignal;
    let resolve!: (value: string) => void;
    const request = vi.fn((_draft: string, nextSignal: AbortSignal) => {
      signal = nextSignal;
      return new Promise<string>((done) => { resolve = done; });
    });
    const controller = createPromptComposerTextareaController({
      textarea: () => undefined, ghostLayer: () => undefined, composerForm: () => undefined,
      promptText: () => "", setPromptText: () => {}, activeSessionId: () => "session-1",
      attachmentsCount: () => 0, editorMode: () => false, questionMode: () => false,
      autocompleteEnabled: () => true, ready: () => true, promptRunning: () => running,
      requestAutocomplete: request,
    });
    try {
      controller.setDebounceMs(0);
      controller.observe();
      await vi.runOnlyPendingTimersAsync();
      expect(request).not.toHaveBeenCalled();
      running = false;
      controller.observe();
      await vi.runOnlyPendingTimersAsync();
      expect(request).toHaveBeenCalledOnce();
      running = true;
      controller.observe();
      expect(signal.aborted).toBe(true);
      resolve("old turn");
      await Promise.resolve();
      expect(controller.suggestion).toBe("");
      running = false;
      controller.observe();
      await vi.runOnlyPendingTimersAsync();
      expect(request).toHaveBeenCalledTimes(2);
      resolve("Добавь тесты");
      await Promise.resolve();
      expect(controller.suggestion).toBe("Добавь тесты");
      expect(promptComposerSource).toContain('if (textareaController.suggestion) return "";');
    } finally {
      controller.dispose();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
  it("locks the composer height while measuring so the transcript scroll is not clamped", () => {
    vi.stubGlobal("window", { innerHeight: 1000 });
    const formStyle = { minHeight: "" };
    const textareaStyle = { height: "300px", overflowY: "auto" } as Record<string, string>;
    const minHeightDuringMeasure: string[] = [];
    const textarea = {
      value: "long draft",
      selectionStart: 10,
      selectionEnd: 10,
      style: textareaStyle,
      scrollTop: 180,
      offsetHeight: 300,
      get scrollHeight() {
        minHeightDuringMeasure.push(formStyle.minHeight);
        // Collapsing to height:auto resets the textarea's own scroll.
        this.scrollTop = 0;
        return 900;
      },
    };
    const form = {
      style: formStyle,
      offsetHeight: 360,
      getBoundingClientRect: () => ({ height: 360.5 }),
    };
    const controller = createPromptComposerTextareaController({
      textarea: () => textarea as unknown as HTMLTextAreaElement,
      ghostLayer: () => undefined,
      composerForm: () => form as unknown as HTMLFormElement,
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
    try {
      controller.resize();
      expect(minHeightDuringMeasure).toEqual(["360.5px"]);
      expect(formStyle.minHeight).toBe("");
      expect(textareaStyle.height).toBe("440px");
      expect(textareaStyle.overflowY).toBe("auto");
      expect(textarea.scrollTop).toBe(180);
    } finally {
      controller.dispose();
      vi.unstubAllGlobals();
    }
  });
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
