import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createSessionActivityStore } from "./session-activity.svelte";
import { createActiveSessionState } from "./active-session-state.svelte";
import type { ConversationBranchActionsOptions } from "./conversation-branch-options";
import { createForkConversation } from "./conversation-fork-action";

function deferred<T>() {
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((_resolve, fail) => { reject = fail; });
  return { promise, reject };
}

function fixture() {
  const state = createActiveSessionState();
  state.setSessionId("source");
  state.setRuntimeReady(true);
  const activity = createSessionActivityStore();
  activity.open("source");
  const restore = deferred<Awaited<ReturnType<AcpClient["loadSession"]>>>();
  const client = {
    forkSession: vi.fn(async () => ({ sessionId: "fork", configOptions: [] })),
    closeSession: vi.fn(async () => {}),
    loadSession: vi.fn(() => { activity.open("source"); return restore.promise; }),
  } as unknown as AcpClient;
  let historyGeneration = 0;
  const forgetRuntime = vi.fn((sessionId: string) => activity.markForgotten(sessionId));
  const reportError = vi.fn();
  const options = {
    client: () => client, state, workspace: () => "/workspace",
    operationRunning: () => false, setOperationRunning: vi.fn(),
    promptRunning: () => false, sessionHistoryLoading: () => false,
    closeProjectSelector: vi.fn(), closeSessionSelector: vi.fn(), clearCommandPicker: vi.fn(),
    forgetRuntime, clearSessionActivity: vi.fn(),
    markRuntimeReady: vi.fn(),
    beginHistoryLoad: () => ++historyGeneration,
    isHistoryLoadCurrent: (request: AcpClient, sessionId: string, workspace: string, generation: number) =>
      request === client && sessionId === state.sessionId && workspace === "/workspace" && generation === historyGeneration,
    hydrateHistory: vi.fn(async () => {}),
    cancelHistoryLoad: vi.fn(() => { historyGeneration += 1; }),
    markHistoryFullyLoaded: vi.fn(), markSourceClosed: vi.fn(),
    ensureProvisionalSession: vi.fn(), showSessionTab: vi.fn(), rememberActiveSession: vi.fn(),
    nextLocalMessageId: () => "message", setPromptText: vi.fn(), setPromptAttachments: vi.fn(),
    invalidateAttachmentDraft: vi.fn(), refreshSessions: vi.fn(),
    scrollToLatest: vi.fn(async () => { throw new Error("handoff failed"); }),
    setErrorMessage: vi.fn(), reportError,
  } satisfies ConversationBranchActionsOptions;
  return { state, activity, restore, client, options, forgetRuntime, reportError,
    replaceHistory: () => { historyGeneration += 1; } };
}

describe("fork source restore failure", () => {
  it("releases the failed source attachment after a direct load", async () => {
    const f = fixture();
    const pending = createForkConversation(f.options)("entry");
    await vi.waitFor(() => expect(f.client.loadSession).toHaveBeenCalledOnce());
    expect(f.activity.ownedSessionCount).toBe(1);
    f.restore.reject(new Error("restore failed"));
    await pending;
    expect(f.forgetRuntime).toHaveBeenCalledWith("source");
    expect(f.activity.ownedSessionCount).toBe(0);
    expect(f.state.sessionId).toBeNull();
    expect(f.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("restore failed") }));
  });

  it("does not release a replacement attachment to the same ID", async () => {
    const f = fixture();
    const pending = createForkConversation(f.options)("entry");
    await vi.waitFor(() => expect(f.client.loadSession).toHaveBeenCalledOnce());
    f.replaceHistory();
    f.state.setSessionId("source");
    f.restore.reject(new Error("obsolete restore failure"));
    await pending;
    expect(f.forgetRuntime).toHaveBeenCalledTimes(2); // original source close and fork cleanup
    expect(f.activity.ownedSessionCount).toBe(1);
    expect(f.state.sessionId).toBe("source");
    expect(f.reportError).not.toHaveBeenCalled();
  });
});
