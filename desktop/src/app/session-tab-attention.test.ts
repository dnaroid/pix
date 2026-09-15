import { describe, expect, it } from "vitest";
import { createSessionTabAttentionStore } from "./session-tab-attention.svelte";

describe("session tab attention store", () => {
  it("marks only background completions and clears them when viewed or reset", () => {
    const store = createSessionTabAttentionStore();

    store.markCompleted("visible", true);
    store.markCompleted("background", false);
    expect(store.unseenCompletedSessionIds).toEqual(new Set(["background"]));

    store.clear("background");
    expect(store.unseenCompletedSessionIds.size).toBe(0);

    store.markCompleted("background", false);
    store.reset();
    expect(store.unseenCompletedSessionIds.size).toBe(0);
  });
});
