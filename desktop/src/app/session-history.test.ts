import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createActiveSessionState } from "./active-session-state.svelte";
import { createSessionHistory } from "./session-history.svelte";

describe("desktop lazy session history", () => {
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
