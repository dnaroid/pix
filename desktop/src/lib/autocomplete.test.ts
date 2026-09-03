import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PromptAutocompleteController,
  cleanAutocompleteSuffix,
  isAutocompleteEligible,
  type PromptAutocompleteState,
} from "./autocomplete";

function state(overrides: Partial<PromptAutocompleteState> = {}): PromptAutocompleteState {
  const text = overrides.text ?? "implement";
  return {
    contextKey: "session-1",
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
    hasAttachments: false,
    enabled: true,
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe("prompt autocomplete", () => {
  it("matches TUI draft eligibility", () => {
    expect(isAutocompleteEligible(state())).toBe(true);
    expect(isAutocompleteEligible(state({ text: "ab", selectionStart: 2, selectionEnd: 2 }))).toBe(false);
    expect(isAutocompleteEligible(state({ text: "/model" }))).toBe(false);
    expect(isAutocompleteEligible(state({ text: "!pwd" }))).toBe(false);
    expect(isAutocompleteEligible(state({ selectionStart: 2, selectionEnd: 2 }))).toBe(false);
    expect(isAutocompleteEligible(state({ selectionStart: 2, selectionEnd: 4 }))).toBe(false);
    expect(isAutocompleteEligible(state({ hasAttachments: true }))).toBe(false);
    expect(isAutocompleteEligible(state({ enabled: false }))).toBe(false);
  });

  it("debounces requests and publishes a cleaned suffix", async () => {
    vi.useFakeTimers();
    const suggestions: string[] = [];
    const request = vi.fn(async () => "completion: implement the feature");
    const controller = new PromptAutocompleteController({
      request,
      onSuggestion: (value) => suggestions.push(value),
      debounceMs: 350,
    });

    controller.observe(state());
    await vi.advanceTimersByTimeAsync(349);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledOnce();
    expect(suggestions).toEqual([" the feature"]);
  });

  it("aborts superseded work and ignores its late response", async () => {
    vi.useFakeTimers();
    const suggestions: string[] = [];
    let resolveFirst!: (value: string) => void;
    let firstWasAborted = false;
    const request = vi.fn((draft: string, signal: AbortSignal) => {
      if (draft === "implement") {
        signal.addEventListener("abort", () => { firstWasAborted = true; }, { once: true });
        return new Promise<string>((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve(" the new result");
    });
    const controller = new PromptAutocompleteController({
      request,
      onSuggestion: (value) => suggestions.push(value),
      debounceMs: 0,
    });

    controller.observe(state());
    await vi.runOnlyPendingTimersAsync();
    controller.observe(state({ text: "implement this" }));
    await vi.runOnlyPendingTimersAsync();
    expect(firstWasAborted).toBe(true);
    resolveFirst(" stale");
    await vi.waitFor(() => expect(suggestions).toEqual([" the new result"]));
  });

  it("accepts with an append and keeps dismissal for the unchanged draft", async () => {
    vi.useFakeTimers();
    const suggestions: string[] = [];
    const request = vi.fn(async () => " this feature");
    const controller = new PromptAutocompleteController({
      request,
      onSuggestion: (value) => suggestions.push(value),
      debounceMs: 0,
    });
    const current = state();

    controller.observe(current);
    await vi.runOnlyPendingTimersAsync();
    expect(controller.accept(current)).toBe("implement this feature");
    expect(controller.currentSuggestion(current)).toBe("");

    controller.observe(current);
    await vi.runOnlyPendingTimersAsync();
    controller.dismiss();
    controller.observe(current);
    await vi.runOnlyPendingTimersAsync();
    expect(request).toHaveBeenCalledTimes(2);
    expect(suggestions.at(-1)).toBe("");
  });

  it("cleans fences and caps unexpected long output", () => {
    expect(cleanAutocompleteSuffix("```text\nimplement safely\n```", "implement")).toBe(" safely");
    expect(cleanAutocompleteSuffix("x".repeat(700), "draft")).toHaveLength(320);
  });
});
