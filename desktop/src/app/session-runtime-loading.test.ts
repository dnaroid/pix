import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { TODO_STATE_CHANNEL } from "../lib/session-todos";
import { createSessionActivityStore } from "./session-activity.svelte";
import { createSessionRuntimeLoading } from "./session-runtime-loading";

type LoadResponse = Awaited<ReturnType<AcpClient["loadSession"]>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setup() {
  const activity = createSessionActivityStore();
  const requests: ReturnType<typeof deferred<LoadResponse>>[] = [];
  const client = { loadSession: vi.fn(() => {
    const request = deferred<LoadResponse>();
    requests.push(request);
    return request.promise;
  }) } as unknown as AcpClient;
  let workspace = "/workspace";
  let currentClient = client;
  let activeReady = false;
  let activeOptions: unknown;
  const reportError = vi.fn();
  const onLoadFailed = vi.fn((sessionId: string) => {
    activity.markForgotten(sessionId);
    activity.clear(sessionId);
  });
  const store = createSessionRuntimeLoading({
    client: () => currentClient,
    workspace: () => workspace,
    activeSessionId: () => "a",
    setActiveReady: (ready) => { activeReady = ready; },
    setActiveConfigOptions: (options) => { activeOptions = options; },
    refreshQueueState: vi.fn(),
    reportError,
    onOpen: activity.open,
    onLoadFailed,
  });
  const snapshot = (checkedAt: number) => activity.handle({ sessionId: "a", activityOwner: activity.open("a"), channel: TODO_STATE_CHANNEL, data: {
    version: 1, checkedAt, details: { action: "list", params: {}, tasks: [
      { id: 1, subject: "work", status: "pending" },
    ], nextId: 2 },
  } });
  const succeed = (index: number) => requests[index]!.resolve({ configOptions: [{ id: `option-${index}` }] } as LoadResponse);
  return {
    store, activity, requests, client, onLoadFailed, reportError, snapshot, succeed,
    get activeReady() { return activeReady; },
    get activeOptions() { return activeOptions; },
    get currentClient() { return currentClient; },
    setClient: (next: AcpClient) => { currentClient = next; },
    setWorkspace: (next: string) => { workspace = next; },
  };
}

describe("runtime loading ownership", () => {
  for (const invalidation of ["forget", "reset"] as const) {
    for (const outcome of ["success", "failure"] as const) {
      it(`ignores old ${outcome} after ${invalidation} and same-ID restart, preserving activity`, async () => {
        const state = setup();
        const old = state.store.ensure(state.client, "a", "/workspace");
        if (invalidation === "forget") state.store.forget("a");
        else state.store.reset();
        if (invalidation === "reset") state.activity.reset();
        const current = state.store.ensure(state.client, "a", "/workspace");
        state.snapshot(Date.now() + 1);
        expect(state.activity.summaries.get("a")?.openTodos).toBe(1);

        if (outcome === "success") state.succeed(0);
        else state.requests[0]!.reject(new Error("obsolete failure"));
        await old;
        expect(state.store.isLoading("a")).toBe(true);
        expect(state.store.isReady("a")).toBe(false);
        expect(state.activity.summaries.get("a")?.openTodos).toBe(1);
        expect(state.onLoadFailed).not.toHaveBeenCalled();
        expect(state.reportError).not.toHaveBeenCalled();

        state.succeed(1);
        await current;
        expect(state.store.isReady("a")).toBe(true);
        expect(state.activeReady).toBe(true);
        expect(state.activeOptions).toEqual([{ id: "option-1" }]);
        expect(state.store.pendingLoadCount).toBe(0);
      });
    }
  }

  it("only reports a failure owned by the current client and workspace", async () => {
    const state = setup();
    const old = state.store.ensure(state.client, "a", "/workspace");
    state.setWorkspace("/other");
    state.requests[0]!.reject(new Error("old workspace"));
    await old;
    expect(state.onLoadFailed).not.toHaveBeenCalled();
    expect(state.reportError).not.toHaveBeenCalled();

    state.store.reset();
    state.activity.reset();
    const current = state.store.ensure(state.client, "a", "/other");
    state.requests[1]!.reject(new Error("current workspace"));
    await current;
    expect(state.onLoadFailed).toHaveBeenCalledTimes(1);
    expect(state.reportError).toHaveBeenCalledTimes(1);
    expect(state.store.pendingLoadCount).toBe(0);
  });

  it("does not revoke activity for an old client after reconnect", async () => {
    const state = setup();
    const old = state.store.ensure(state.client, "a", "/workspace");
    state.store.reset();
    state.activity.reset();
    state.setClient({ loadSession: () => {
      const current = deferred<LoadResponse>();
      state.requests.push(current);
      return current.promise;
    } } as unknown as AcpClient);
    const current = state.store.ensure(state.currentClient, "a", "/workspace");
    // A replacement client can use the same session ID and workspace.
    state.snapshot(Date.now() + 1);
    state.requests[0]!.reject(new Error("old client"));
    await old;
    expect(state.onLoadFailed).not.toHaveBeenCalled();
    expect(state.activity.summaries.get("a")?.openTodos).toBe(1);
    state.succeed(1);
    await current;
    expect(state.store.isReady("a")).toBe(true);
  });

  it("does not revoke externally marked-ready activity when an old load fails", async () => {
    const state = setup();
    const old = state.store.ensure(state.client, "a", "/workspace");
    state.store.markReady("a", []);
    state.snapshot(Date.now() + 1);
    state.requests[0]!.reject(new Error("superseded"));
    await old;
    expect(state.store.isReady("a")).toBe(true);
    expect(state.store.pendingLoadCount).toBe(0);
    expect(state.activity.summaries.get("a")?.openTodos).toBe(1);
    expect(state.onLoadFailed).not.toHaveBeenCalled();
    expect(state.reportError).not.toHaveBeenCalled();
  });

  it("ignores old failure even when the replacement completed first", async () => {
    const state = setup();
    const old = state.store.ensure(state.client, "a", "/workspace");
    state.store.forget("a");
    const current = state.store.ensure(state.client, "a", "/workspace");
    state.succeed(1);
    await current;
    state.snapshot(Date.now() + 1);
    state.requests[0]!.reject(new Error("late failure"));
    await old;
    expect(state.store.isReady("a")).toBe(true);
    expect(state.activity.summaries.get("a")?.openTodos).toBe(1);
    expect(state.onLoadFailed).not.toHaveBeenCalled();
    expect(state.store.pendingLoadCount).toBe(0);
  });

  it("bounds pending ownership across many closed IDs and ignores late completion", async () => {
    const state = setup();
    const background = state.store.ensure(state.client, "background", "/workspace");
    for (let index = 0; index < 500; index++) {
      const id = `closed-${index}`;
      const pending = state.store.ensure(state.client, id, "/workspace");
      state.store.forget(id);
      state.requests[index + 1]!.reject(new Error("closed"));
      await pending;
    }
    expect(state.store.pendingLoadCount).toBe(1);
    expect(state.onLoadFailed).not.toHaveBeenCalled();
    state.succeed(0);
    await background;
    expect(state.store.isReady("background")).toBe(true);
    expect(state.store.pendingLoadCount).toBe(0);
  });
});
