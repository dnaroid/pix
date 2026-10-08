import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { appendLocalUserMessage } from "../lib/transcript";
import { createActiveSessionState } from "./active-session-state.svelte";
import { createSessionHistory } from "./session-history.svelte";

describe("desktop lazy session history", () => {
  it("restores incomplete history without reviving a retired hydration request", async () => {
    let finish!: (value: unknown) => void;
    const client = { sessionHistory: () => new Promise((resolve) => { finish = resolve; }) } as unknown as AcpClient;
    const state = createActiveSessionState();
    state.setSessionId("closing");
    state.initializeSessionTranscript("closing");
    const history = createSessionHistory({
      client: () => client, state, workspace: () => "/project", ensureRuntime: vi.fn(),
      runtimeReady: () => true, scheduleScrollToLatest: vi.fn(), recoverUnavailableSession: vi.fn(), reportError: vi.fn(),
    });
    const hydration = history.hydrate(client, "closing", "/project", history.begin());
    const rollback = history.captureRollback("closing");
    history.forget("closing");
    state.setSessionId("next");
    rollback();
    finish({ updates: [{ sessionUpdate: "user_message_chunk", messageId: "old", content: { type: "text", text: "stale" } }], deferredToolCallIds: [] });
    await hydration;
    expect(history.needsHydration("closing")).toBe(true);
    expect(state.sessionTranscript("closing")?.items).toHaveLength(0);
  });

  it("restores an older-history cursor after a failed close", async () => {
    const sessionHistory = vi.fn()
      .mockResolvedValueOnce({ updates: [], deferredToolCallIds: [], cursor: "older" })
      .mockResolvedValueOnce({ updates: [{ sessionUpdate: "user_message_chunk", messageId: "old", content: { type: "text", text: "older" } }], deferredToolCallIds: [] });
    const client = { sessionHistory } as unknown as AcpClient;
    const state = createActiveSessionState();
    state.setSessionId("closing");
    state.initializeSessionTranscript("closing");
    const history = createSessionHistory({
      client: () => client, state, workspace: () => "/project", ensureRuntime: vi.fn(),
      runtimeReady: () => true, scheduleScrollToLatest: vi.fn(), recoverUnavailableSession: vi.fn(), reportError: vi.fn(),
    });
    await history.hydrate(client, "closing", "/project", history.begin());
    const rollback = history.captureRollback("closing");
    history.forget("closing");
    expect(history.olderCursorCount).toBe(0);
    rollback();
    expect(await history.loadOlder()).toBe(true);
    expect(sessionHistory).toHaveBeenLastCalledWith("closing", false, "older");
    expect(state.transcript.items).toHaveLength(1);
  });

  it.each(["none", "reset", "forget"])("primes background history without active hydration or selection changes (%s)", async (invalidation) => {
    let finish!: (value: unknown) => void;
    const client = { sessionHistory: () => new Promise((resolve) => { finish = resolve; }) } as unknown as AcpClient;
    const state = createActiveSessionState();
    state.setSessionId("source");
    state.initializeSessionTranscript("source");
    const history = createSessionHistory({
      client: () => client, state, workspace: () => "/project", ensureRuntime: vi.fn(),
      runtimeReady: () => true, scheduleScrollToLatest: vi.fn(), recoverUnavailableSession: vi.fn(), reportError: vi.fn(),
    });
    const activeGeneration = history.begin();
    const work = history.primeBackground(client, "child", "/project");
    if (invalidation === "reset") history.reset();
    if (invalidation === "forget") history.forget("child");
    finish({ updates: [{ sessionUpdate: "user_message_chunk", messageId: "replay-1", content: { type: "text", text: "inherited" } }], deferredToolCallIds: [], cursor: "99" });
    expect(await work).toBe(invalidation === "none");
    expect(state.sessionId).toBe("source");
    expect(state.transcript.items).toEqual([]);
    if (invalidation === "none") {
      expect(history.generation).toBe(activeGeneration);
      expect(history.loading).toBe(true);
      expect(history.olderCursorCount).toBe(1);
      expect(state.sessionTranscript("child")?.items).toHaveLength(1);
    } else {
      expect(state.sessionTranscript("child")).toBeUndefined();
    }
  });
  it.each([false, true])("preserves an optimistic prompt while history settles (missing=%s)", async (missing) => {
    let finish!: (value: unknown) => void;
    let fail!: (error: Error) => void;
    const client = { sessionHistory: () => new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    }) } as unknown as AcpClient;
    const state = createActiveSessionState();
    state.setSessionId("session-1");
    state.initializeSessionTranscript("session-1");
    const ensureRuntime = vi.fn(async () => {});
    const reportError = vi.fn();
    const history = createSessionHistory({
      client: () => client, state, workspace: () => "/project",
      ensureRuntime, runtimeReady: () => true,
      scheduleScrollToLatest: vi.fn(), recoverUnavailableSession: vi.fn(), reportError,
    });
    const pending = history.hydrate(client, "session-1", "/project", history.begin());
    let settled = false;
    const wait = history.waitForHydration("session-1").then(() => { settled = true; });
    state.setTranscript(appendLocalUserMessage(state.transcript, "optimistic", "local:1"));
    state.setSessionTranscript("session-1", state.transcript);
    expect(settled).toBe(false);
    if (missing) fail(new Error("session history session-1 is unavailable"));
    else finish({ updates: [{
      sessionUpdate: "user_message_chunk", messageId: "replay-0",
      content: { type: "text", text: "persisted" },
    }], deferredToolCallIds: [] });
    await pending;
    await wait;
    expect(state.transcript.items.map((item) => item.type === "message" ? item.text : "")).toEqual(
      missing ? ["optimistic"] : ["persisted", "optimistic"],
    );
    expect(settled).toBe(true);
    expect(ensureRuntime).toHaveBeenCalledTimes(missing ? 1 : 0);
    expect(reportError).not.toHaveBeenCalled();
  });
  it("prepends the previous cursor page without replacing the visible tail", async () => {
    const sessionHistory = vi.fn()
      .mockResolvedValueOnce({
        updates: [{
          sessionUpdate: "user_message_chunk",
          messageId: "replay-0",
          content: { type: "text", text: "newer" },
        }],
        deferredToolCallIds: [],
        cursor: "4096",
      })
      .mockResolvedValueOnce({
        updates: [{
          sessionUpdate: "user_message_chunk",
          messageId: "replay-entry:u1",
          content: { type: "text", text: "older" },
        }],
        deferredToolCallIds: [],
      });
    const client = { sessionHistory } as unknown as AcpClient;
    const state = createActiveSessionState();
    state.setSessionId("session-1");
    state.initializeSessionTranscript("session-1");
    const history = createSessionHistory({
      client: () => client,
      state,
      workspace: () => "/project",
      ensureRuntime: vi.fn(async () => {}),
      runtimeReady: () => true,
      scheduleScrollToLatest: vi.fn(),
      recoverUnavailableSession: vi.fn(),
      reportError: vi.fn(),
    });

    const generation = history.begin();
    await history.hydrate(client, "session-1", "/project", generation);
    expect(state.transcript.items.map((item) => item.type === "message" ? item.text : item.title)).toEqual(["newer"]);

    await expect(history.loadOlder()).resolves.toBe(true);
    expect(sessionHistory).toHaveBeenNthCalledWith(2, "session-1", false, "4096");
    expect(state.transcript.items.map((item) => item.type === "message" ? item.text : item.title)).toEqual([
      "older",
      "newer",
    ]);
    await expect(history.loadOlder()).resolves.toBe(false);
    expect(sessionHistory).toHaveBeenCalledTimes(2);
  });

  it("drops the older cursor after another flow materializes full history", async () => {
    const sessionHistory = vi.fn().mockResolvedValue({
      updates: [{
        sessionUpdate: "user_message_chunk",
        messageId: "replay-0",
        content: { type: "text", text: "tail" },
      }],
      deferredToolCallIds: [],
      cursor: "4096",
    });
    const client = { sessionHistory } as unknown as AcpClient;
    const state = createActiveSessionState();
    state.setSessionId("session-1");
    state.initializeSessionTranscript("session-1");
    const history = createSessionHistory({
      client: () => client,
      state,
      workspace: () => "/project",
      ensureRuntime: vi.fn(async () => {}),
      runtimeReady: () => true,
      scheduleScrollToLatest: vi.fn(),
      recoverUnavailableSession: vi.fn(),
      reportError: vi.fn(),
    });

    const generation = history.begin();
    await history.hydrate(client, "session-1", "/project", generation);
    history.markFullyLoaded("session-1");

    await expect(history.loadOlder()).resolves.toBe(false);
    expect(sessionHistory).toHaveBeenCalledTimes(1);
  });
});
