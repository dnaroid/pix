import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createSessionActivityStore } from "./session-activity.svelte";
import { createActiveSessionState } from "./active-session-state.svelte";
import type { ConversationBranchActionsOptions } from "./conversation-branch-options";
import { createForkConversation } from "./conversation-fork-action";
import { createComposerDraftStore } from "./composer-drafts";
import { appendLocalSystemMessage, emptyTranscript } from "../lib/transcript";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
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
  const options: ConversationBranchActionsOptions = {
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
    switchComposerDraft: vi.fn(),
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

describe("fork in new tab while source is running", () => {
  function runningFixture() {
    const f = fixture();
    f.options.promptRunning = () => true;
    f.options.scrollToLatest = vi.fn(async () => {});
    return f;
  }

  it("keeps the running source open, preserves its latest transcript and composer, and isolates later source updates", async () => {
    const f = runningFixture();
    const fork = deferred<Awaited<ReturnType<AcpClient["forkSession"]>>>();
    vi.mocked(f.client.forkSession).mockReturnValue(fork.promise);
    let text = "unsent follow-up";
    const sourceAttachment = { id: "source-file", name: "source.txt", kind: "file" as const, mimeType: "text/plain" };
    let attachments: Parameters<ConversationBranchActionsOptions["setPromptAttachments"]>[0] = [sourceAttachment];
    const drafts = createComposerDraftStore({
      workspace: f.options.workspace,
      promptText: () => text, promptAttachments: () => attachments,
      setPromptText: (next) => { text = next; },
      replacePromptAttachments: (next) => { attachments = [...next]; },
    });
    f.options.switchComposerDraft = drafts.switchTo;
    f.options.setPromptText = (next) => { text = next; };
    f.options.setPromptAttachments = (next) => { attachments = next; };
    const pending = createForkConversation(f.options)("entry", { keepSourceOpen: true });
    const latest = appendLocalSystemMessage(emptyTranscript, "source still working", "source-update");
    f.state.setTranscriptFor("source", latest);
    text = "edited while fork starts";
    fork.resolve({ sessionId: "fork", configOptions: [], selectedText: "selected prompt" });
    await pending;
    expect(f.client.forkSession).toHaveBeenCalledWith("source", "/workspace", "entry");
    expect(f.state.sessionId).toBe("fork");
    expect(f.state.sessionTranscript("source")).toEqual(latest);
    expect(text).toBe("selected prompt");
    expect(attachments).toEqual([]);
    expect(f.client.closeSession).not.toHaveBeenCalled();
    expect(f.forgetRuntime).not.toHaveBeenCalled();
    expect(f.options.clearSessionActivity).not.toHaveBeenCalled();
    expect(f.options.markSourceClosed).not.toHaveBeenCalled();
    const forkTranscript = f.state.transcript;
    f.state.setTranscriptFor("source", appendLocalSystemMessage(latest, "late source event", "late"));
    expect(f.state.transcript).toEqual(forkTranscript);
    expect(text).toBe("selected prompt");
    drafts.switchTo("fork", "source");
    expect(text).toBe("edited while fork starts");
    expect(attachments).toEqual([sourceAttachment]);
    expect(f.options.showSessionTab).toHaveBeenCalledWith("fork");
  });

  it("still blocks source replacement while running", async () => {
    const f = runningFixture();
    await createForkConversation(f.options)("entry");
    expect(f.client.forkSession).not.toHaveBeenCalled();
    expect(f.options.setOperationRunning).not.toHaveBeenCalled();
  });

  it.each(["operationRunning", "sessionHistoryLoading"] as const)("keeps the %s gate", async (gate) => {
    const f = runningFixture();
    f.options[gate] = () => true;
    await createForkConversation(f.options)("entry", { keepSourceOpen: true });
    expect(f.client.forkSession).not.toHaveBeenCalled();
  });

  it("discards a stale fork without changing the selected tab or closing the source", async () => {
    const f = runningFixture();
    const fork = deferred<Awaited<ReturnType<AcpClient["forkSession"]>>>();
    vi.mocked(f.client.forkSession).mockReturnValue(fork.promise);
    const pending = createForkConversation(f.options)("entry", { keepSourceOpen: true });
    f.state.setSessionId("other");
    fork.resolve({ sessionId: "fork", configOptions: [] });
    await pending;
    expect(f.state.sessionId).toBe("other");
    expect(f.client.closeSession).toHaveBeenCalledExactlyOnceWith("fork");
    expect(f.options.switchComposerDraft).not.toHaveBeenCalled();
    expect(f.options.showSessionTab).not.toHaveBeenCalled();
  });
});
