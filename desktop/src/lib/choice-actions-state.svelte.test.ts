import { describe, expect, it } from "vitest";
import { createChoiceActionsStateCache } from "./choice-actions-state.svelte";
import type { ChoiceActions } from "./choice-actions";

const actions: ChoiceActions = {
  submitLabel: "Continue",
  items: [{ label: "One", checked: true }, { label: "Two", checked: false }],
};

describe("quick-choice state across transcript remounts", () => {
  it("restores changed and empty selections instead of model defaults", () => {
    const cache = createChoiceActionsStateCache();
    const first = cache.get("session-a/message", 0, actions);
    expect(first.selected).toEqual([0]);
    first.selected = [1];
    cache.get("session-b/message", 0, actions).selected = [0, 1];
    expect(cache.get("session-a/message", 0, structuredClone(actions)).selected).toEqual([1]);
    first.selected = [];
    expect(cache.get("session-a/message", 0, actions).selected).toEqual([]);
  });

  it("isolates sessions, messages, block positions and changed block content", () => {
    const cache = createChoiceActionsStateCache();
    cache.get("session-a/message", 0, actions).selected = [1];
    for (const [scope, index, block] of [
      ["session-b/message", 0, actions],
      ["session-a/other-message", 0, actions],
      ["session-a/message", 1, actions],
      ["session-a/message", 0, { ...actions, submitLabel: "Apply" }],
    ] as const) {
      expect(cache.get(scope, index, block).selected).toEqual([0]);
    }
  });

  it("shares pending completion with a remounted block without affecting another session", async () => {
    const cache = createChoiceActionsStateCache();
    const original = cache.get("a", 0, actions);
    original.submitting = true;
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => { complete = resolve; }).then(() => {
      original.submitted = true;
      original.submitting = false;
    });
    const remounted = cache.get("a", 0, actions);
    expect(remounted.submitting).toBe(true);
    expect(cache.get("b", 0, actions).submitting).toBe(false);
    complete();
    await pending;
    expect(remounted.submitted).toBe(true);
    expect(remounted.submitting).toBe(false);
    expect(cache.get("b", 0, actions).submitted).toBe(false);
  });

  it("retains errors for retry and leaves unscoped renders independent", () => {
    const cache = createChoiceActionsStateCache();
    cache.get("a", 0, actions).error = "Failed";
    expect(cache.get("a", 0, actions).error).toBe("Failed");
    cache.get(undefined, 0, actions).selected = [];
    expect(cache.get(undefined, 0, actions).selected).toEqual([0]);
  });

  it("bounds retained state using LRU while protecting pending submissions", () => {
    const cache = createChoiceActionsStateCache(2);
    const pending = cache.get("pending", 0, actions);
    pending.submitting = true;
    const evicted = cache.get("old", 0, actions);
    cache.get("new", 0, actions);
    expect(cache.get("pending", 0, actions)).toBe(pending);
    expect(cache.get("old", 0, actions)).not.toBe(evicted);
  });
});
