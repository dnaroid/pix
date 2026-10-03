import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { appendLocalUserMessage, applySessionUpdates, emptyTranscript, type MessageItem } from "../lib/transcript";
import { createActiveSessionState } from "./active-session-state.svelte";
import type { ConversationBranchActionsOptions } from "./conversation-branch-options";
import { createUserMessageContextActions } from "./user-message-context-actions";

function fixture() {
  const state = createActiveSessionState();
  state.setSessionId("source");
  const client = {
    branchUserMessages: vi.fn(async () => [
      { entryId: "hidden", text: "" },
      { entryId: "selected", text: "same prompt" },
      { entryId: "later", text: "same prompt" },
      { entryId: "in-flight", text: "new prompt" },
    ]),
    userMessageAction: vi.fn(async () => ({})),
  } as unknown as AcpClient;
  const fork = vi.fn(async () => {});
  const reportError = vi.fn();
  const options = {
    client: () => client, state, workspace: () => "/project", reportError,
  } as unknown as ConversationBranchActionsOptions;
  const actions = createUserMessageContextActions(options, fork);
  return { state, client, fork, reportError, ...actions };
}

describe("user message action identity", () => {
  it.each(["fork", "fork-new-tab", "copy"] as const)(
    "targets the selected persisted entry for %s despite hidden, identical and in-flight users",
    async (action) => {
      const f = fixture();
      f.state.setTranscript(applySessionUpdates(emptyTranscript, [
        { sessionUpdate: "user_message_chunk", messageId: "replay-entry:selected", content: { type: "text", text: "same prompt" } },
        { sessionUpdate: "user_message_chunk", messageId: "replay-entry:later", content: { type: "text", text: "same prompt" } },
      ]));
      await f.runUserMessageContextAction(f.state.transcript.items[0] as MessageItem, action);
      if (action === "copy") expect(f.client.userMessageAction).toHaveBeenCalledWith("source", "selected", "copy");
      else if (action === "fork-new-tab") expect(f.fork).toHaveBeenCalledWith("selected", { keepSourceOpen: true });
      else expect(f.fork).toHaveBeenCalledWith("selected");
      expect(f.client.branchUserMessages).not.toHaveBeenCalled();
      expect(f.reportError).not.toHaveBeenCalled();
    },
  );

  it("uses an explicitly bound optimistic entry", async () => {
    const f = fixture();
    const message = { type: "message", role: "user", id: "local:1", text: "same prompt", attachments: [], sessionEntryId: "selected" } as MessageItem;
    await expect(f.resolveUserMessageSessionEntryId(message)).resolves.toBe("selected");
  });

  it("refuses to guess the target of an unbound optimistic row", async () => {
    const f = fixture();
    f.state.setTranscript(appendLocalUserMessage(emptyTranscript, "same prompt", "local:1"));
    await f.runUserMessageContextAction(f.state.transcript.items[0] as MessageItem, "fork-new-tab");
    expect(f.fork).not.toHaveBeenCalled();
    expect(f.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("not available yet") }));
  });

  it("refuses legacy positional history rather than silently selecting another entry", async () => {
    const f = fixture();
    const message = { type: "message", role: "user", id: "old", messageId: "replay-0", text: "same prompt", attachments: [] } as MessageItem;
    await expect(f.resolveUserMessageSessionEntryId(message)).rejects.toThrow("not available yet");
  });
});
