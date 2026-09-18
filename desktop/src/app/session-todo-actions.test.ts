import { describe, expect, it } from "vitest";
import { createSessionTodoActions } from "./session-todo-actions";

describe("session todo actions", () => {
  it("keeps per-session pending state across view remounts and tab switches", async () => {
    let active = "a";
    const calls: string[] = [];
    const releases = new Map<string, () => void>();
    const actions = createSessionTodoActions({
      client: () => ({ clearTodos: (id) => {
        calls.push(id);
        return new Promise<void>((resolve) => releases.set(id, resolve));
      } }),
      ready: (id) => id === active,
      reportError: () => { throw new Error("unexpected failure"); },
    });
    const first = actions.clear("a");
    expect(actions.canClear("a")).toBe(false);
    active = "b";
    expect(actions.canClear("b")).toBe(true);
    const second = actions.clear("b");
    active = "a";
    // A remounted inspector asks the same session-owned controller again.
    expect(actions.canClear("a")).toBe(false);
    expect(await actions.clear("a")).toBe(false);
    expect(calls).toEqual(["a", "b"]);
    releases.get("a")!();
    expect(await first).toBe(true);
    expect(actions.canClear("a")).toBe(true);
    active = "b";
    expect(actions.canClear("b")).toBe(false);
    releases.get("b")!();
    expect(await second).toBe(true);
    expect(actions.canClear("b")).toBe(true);
  });

  it("reports failures, releases guards, and refuses unavailable or stale targets", async () => {
    let ready = true;
    let available = true;
    const failure = new Error("clear failed");
    const errors: unknown[] = [];
    let calls = 0;
    const actions = createSessionTodoActions({
      client: () => available ? { clearTodos: async () => { calls++; throw failure; } } : null,
      ready: (id) => ready && id === "active",
      reportError: (error) => errors.push(error),
    });
    expect(await actions.clear("active")).toBe(false);
    expect(errors).toEqual([failure]);
    expect(actions.canClear("active")).toBe(true);
    expect(await actions.clear("old")).toBe(false);
    ready = false;
    expect(await actions.clear("active")).toBe(false);
    ready = true;
    available = false;
    expect(await actions.clear("active")).toBe(false);
    expect(calls).toBe(1);
  });
});
