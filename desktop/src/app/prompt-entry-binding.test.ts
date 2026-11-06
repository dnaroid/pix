import { describe, expect, it, vi } from "vitest";
import type { AcpClient, ForkMessage } from "../lib/acp-client";
import { appendLocalUserMessage, bindLocalUserMessageSessionEntry, emptyTranscript, type MessageItem } from "../lib/transcript";
import { createActiveSessionState } from "./active-session-state.svelte";
import type { ConversationBranchActionsOptions } from "./conversation-branch-options";
import { createPromptRunLifecycle } from "./prompt-run-lifecycle.svelte";
import { createUserMessageContextActions } from "./user-message-context-actions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const old = { entryId: "old", text: "repeat" };
const submitted = { entryId: "submitted", text: "repeat" };
const steering = { entryId: "steering", text: "repeat" };

async function fixture() {
  const started = deferred<() => void | Promise<void>>();
  const response = deferred<{ stopReason: "end_turn" }>();
  const state = createActiveSessionState();
  state.setSessionId("source");
  state.setTranscript(appendLocalUserMessage(emptyTranscript, "repeat", "local:1"));
  const branchUserMessages = vi.fn<() => Promise<ForkMessage[]>>().mockResolvedValue([old]);
  const client = {
    branchUserMessages,
    prompt: vi.fn((_id, _blocks, _images, onUpdate) => {
      started.resolve(onUpdate);
      return response.promise;
    }),
    cancel: vi.fn().mockResolvedValue(undefined),
  } as unknown as AcpClient;
  let activeClient = client;
  const reportError = vi.fn();
  const bindPromptSessionEntry = vi.fn((sessionId: string, rowId: string, entryId?: string) => {
    const transcript = state.transcriptFor(sessionId);
    if (transcript) state.setTranscriptFor(sessionId, bindLocalUserMessageSessionEntry(transcript, rowId, entryId));
  });
  const runs = createPromptRunLifecycle({
    client: () => activeClient, activeSessionId: () => state.sessionId, reportError,
    bindPromptSessionEntry, finalizeTranscriptActivity: vi.fn(), flushAutoQueue: vi.fn(),
  });
  const fork = vi.fn(async () => {});
  const actions = createUserMessageContextActions({
    client: () => activeClient, state, workspace: () => "/project", reportError,
  } as unknown as ConversationBranchActionsOptions, fork);
  const pending = runs.runPromptRequest(client, "source", [], [], "local:1");
  const update = await started.promise;
  return {
    state, client, branchUserMessages, runs, reportError, bindPromptSessionEntry, fork, actions, update, pending,
    replaceClient: () => { activeClient = {} as AcpClient; },
    finish: async () => { response.resolve({ stopReason: "end_turn" }); await pending; },
  };
}

describe("in-flight prompt entry binding", () => {
  it("forks the exact submitted entry before settlement despite duplicate text and later steering", async () => {
    const f = await fixture();
    f.branchUserMessages.mockResolvedValue([old, submitted, steering]);
    await f.update();
    expect(f.runs.isRunning("source")).toBe(true);
    expect(f.bindPromptSessionEntry).toHaveBeenCalledExactlyOnceWith("source", "local:1", "submitted");
    await f.actions.runUserMessageContextAction(f.state.transcript.items[0] as MessageItem, "fork-new-tab");
    expect(f.fork).toHaveBeenCalledExactlyOnceWith("submitted", { keepSourceOpen: true });
    expect(f.client.cancel).not.toHaveBeenCalled();
    await f.update();
    await f.finish();
    expect(f.branchUserMessages).toHaveBeenCalledTimes(2);
    expect(f.bindPromptSessionEntry).toHaveBeenCalledTimes(1);
    expect(f.reportError).not.toHaveBeenCalled();
  });

  it("does not classify a not-yet-persisted row as renderer-only and retries on the next update", async () => {
    const f = await fixture();
    await f.update();
    expect(f.bindPromptSessionEntry).not.toHaveBeenCalled();
    await expect(f.actions.resolveUserMessageSessionEntryId(f.state.transcript.items[0] as MessageItem))
      .rejects.toThrow("not available yet");
    f.branchUserMessages.mockResolvedValue([old, submitted]);
    await f.update();
    expect(f.bindPromptSessionEntry).toHaveBeenCalledWith("source", "local:1", "submitted");
    await f.finish();
  });

  it("coalesces chunks but retains a wakeup that arrives during an empty snapshot", async () => {
    const f = await fixture();
    const snapshot = deferred<ForkMessage[]>();
    f.branchUserMessages.mockReturnValueOnce(snapshot.promise).mockResolvedValue([old, submitted]);
    const reading = f.update();
    for (let i = 0; i < 20; i++) void f.update();
    expect(f.branchUserMessages).toHaveBeenCalledTimes(2);
    snapshot.resolve([old]);
    await reading;
    expect(f.branchUserMessages).toHaveBeenCalledTimes(3);
    expect(f.bindPromptSessionEntry).toHaveBeenCalledExactlyOnceWith("source", "local:1", "submitted");
    await f.finish();
  });

  it.each(["cancel", "clear", "reset", "client", "new run"] as const)(
    "ignores a late early snapshot after %s", async (change) => {
      const f = await fixture();
      const snapshot = deferred<ForkMessage[]>();
      f.branchUserMessages.mockReturnValueOnce(snapshot.promise);
      const reading = f.update();
      if (change === "cancel") await f.runs.cancelActivePrompt();
      if (change === "clear") f.runs.clearSession("source");
      if (change === "reset") f.runs.reset();
      if (change === "client") f.replaceClient();
      if (change === "new run") { f.runs.clearSession("source"); f.runs.beginRun("source"); }
      snapshot.resolve([old, submitted]);
      await reading;
      await f.finish();
      expect(f.bindPromptSessionEntry).not.toHaveBeenCalled();
      expect(f.reportError).not.toHaveBeenCalled();
      f.runs.reset();
    },
  );

  it("binds the source cache rather than another tab after navigation", async () => {
    const f = await fixture();
    const snapshot = deferred<ForkMessage[]>();
    f.branchUserMessages.mockReturnValueOnce(snapshot.promise);
    const reading = f.update();
    f.state.setSessionTranscript("source", f.state.transcript);
    f.state.setSessionId("other");
    f.state.setTranscript(appendLocalUserMessage(emptyTranscript, "other", "local:other"));
    snapshot.resolve([old, submitted]);
    await reading;
    expect((f.state.transcriptFor("source")!.items[0] as MessageItem).sessionEntryId).toBe("submitted");
    expect((f.state.transcript.items[0] as MessageItem).sessionEntryId).toBeUndefined();
    await f.finish();
  });

  it("logs early snapshot failure once and retains the settlement fallback", async () => {
    const f = await fixture();
    const error = new Error("snapshot failed");
    f.branchUserMessages.mockRejectedValueOnce(error).mockResolvedValue([old, submitted, steering]);
    await f.update();
    await f.update();
    expect(f.reportError).toHaveBeenCalledExactlyOnceWith(error);
    expect(f.bindPromptSessionEntry).not.toHaveBeenCalled();
    await f.finish();
    expect(f.bindPromptSessionEntry).toHaveBeenCalledExactlyOnceWith("source", "local:1", "submitted");
  });

  it("does not wait for an early snapshot at settlement or let it overwrite the final binding", async () => {
    const f = await fixture();
    const snapshot = deferred<ForkMessage[]>();
    f.branchUserMessages.mockReturnValueOnce(snapshot.promise).mockResolvedValue([old, submitted]);
    const reading = f.update();
    await f.finish();
    await reading;
    snapshot.resolve([old, steering]);
    expect(f.bindPromptSessionEntry).toHaveBeenCalledExactlyOnceWith("source", "local:1", "submitted");
  });

  it("marks a command with no Pi user entry renderer-only only at settlement", async () => {
    const f = await fixture();
    await f.update();
    expect(f.bindPromptSessionEntry).not.toHaveBeenCalled();
    await f.finish();
    expect(f.bindPromptSessionEntry).toHaveBeenCalledExactlyOnceWith("source", "local:1", undefined);
    expect((f.state.transcript.items[0] as MessageItem).localOnly).toBe(true);
  });
});
