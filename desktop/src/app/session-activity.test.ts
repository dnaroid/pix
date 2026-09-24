import { describe, expect, it, vi } from "vitest";
import { TODO_STATE_CHANNEL } from "../lib/session-todos";
import { SUBAGENTS_LIVE_STATE_CHANNEL } from "../lib/session-subagents";
import { createSessionActivityStore } from "./session-activity.svelte";

function todo(sessionId: string, checkedAt: number, activityOwner: string) {
  return { sessionId, activityOwner, channel: TODO_STATE_CHANNEL, data: {
    version: 1, checkedAt, details: { action: "list", params: {}, tasks: [
      { id: 1, subject: "work", status: "pending" },
    ], nextId: 2 },
  } };
}

function subagent(sessionId: string, checkedAt: number, activityOwner: string) {
  return { sessionId, activityOwner, channel: SUBAGENTS_LIVE_STATE_CHANNEL, data: {
    version: 1, checkedAt, count: 1, runs: [{ runDir: "run", agents: [{ id: "agent", status: "running" }] }],
  } };
}

describe("session activity attachment ownership", () => {
  it("rejects delayed prior envelopes after same-ID reopen regardless of their timestamp", () => {
    const onChange = vi.fn();
    const store = createSessionActivityStore({ onChange });
    const old = store.open("a");
    store.handle(todo("a", 1000, old));
    store.markForgotten("a");
    const next = store.open("a");
    expect(next).not.toBe(old);
    for (const timestamp of [999, 1000, 5000]) {
      store.handle(todo("a", timestamp, old));
      store.handle(subagent("a", timestamp, old));
    }
    expect(store.summaries.has("a")).toBe(false);
    store.handle(todo("a", 500, next));
    store.handle(subagent("a", 500, next));
    expect(store.summaries.get("a")?.openTodos).toBe(1);
    expect(store.summaries.get("a")?.activeSubagents).toBe(1);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("accepts older and same-millisecond cached snapshots for unrelated attachments", () => {
    const store = createSessionActivityStore();
    const prior = store.open("closed");
    store.handle(todo("closed", 2000, prior));
    store.markForgotten("closed");
    store.clear("closed");
    const other = store.open("other");
    store.handle(todo("other", 100, other));
    store.handle(subagent("other", 2000, other));
    expect(store.summaries.get("other")?.openTodos).toBe(1);
    expect(store.summaries.get("other")?.activeSubagents).toBe(1);
  });

  it("stages new/fork startup notifications until response and drops canceled owners", () => {
    const store = createSessionActivityStore();
    store.beginRequest("new");
    store.handle(todo("created", 123, "new"));
    store.handle(subagent("created", 123, "new"));
    expect(store.summaries.size).toBe(0);
    store.completeRequest("new", "created");
    expect(store.summaries.get("created")?.activeSubagents).toBe(1);
    expect(store.open("created")).toBe("new"); // markReady does not remint
    store.beginRequest("failed");
    store.handle(todo("failed-id", 123, "failed"));
    store.cancelRequest("failed");
    store.completeRequest("failed", "failed-id");
    expect(store.summaries.has("failed-id")).toBe(false);
    store.beginRequest("old");
    store.reset();
    store.beginRequest("replacement");
    store.cancelRequest("old");
    store.completeRequest("old", "replacement-id");
    expect(store.pendingRequestCount).toBe(1);
    store.completeRequest("replacement", "replacement-id");
    expect(store.open("replacement-id")).toBe("replacement");
  });

  it("retains metadata for only live sessions and bounded pending requests", () => {
    const store = createSessionActivityStore();
    store.open("background");
    for (let i = 0; i < 500; i++) {
      const id = `closed-${i}`;
      const owner = store.open(id);
      store.handle(todo(id, 2001, owner));
      store.markForgotten(id);
      store.handle(todo(id, 3000, owner));
    }
    expect(store.ownedSessionCount).toBe(1);
    expect(store.pendingRequestCount).toBe(0);
    expect(store.todos.size).toBe(0);
    store.reset();
    expect(store.ownedSessionCount).toBe(0);
  });
});
