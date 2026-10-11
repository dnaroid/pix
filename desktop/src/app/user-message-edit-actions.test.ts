import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { emptyTranscript, type MessageItem } from "../lib/transcript";
import type { ConversationBranchActionsOptions } from "./conversation-branch-options";
import type { MessageEdit } from "./edited-message-submit";
import { createActiveSessionState } from "./active-session-state.svelte";
import { createUserMessageContextActions } from "./user-message-context-actions";

const message: MessageItem = { type: "message", id: "row", role: "user", text: "original", attachments: [], sessionEntryId: "user-1" };

function fixture() {
  const state = createActiveSessionState();
  state.setSessionId("source");
  state.setRuntimeReady(true);
  let running = false;
  let operation = false;
  const order: string[] = [];
  const resend = vi.fn();
  const requestMessageEdit = vi.fn(async (): Promise<MessageEdit | undefined> => ({ text: "edited", attachments: [] }));
  const prepareEditedMessage = vi.fn(async () => { order.push("prepare"); return resend; });
  const userMessageAction = vi.fn(async (_session: string, _entry: string, action: string) => { order.push(action); return { status: "ok" }; });
  const sessionHistory = vi.fn(async () => ({ updates: [], deferredToolCallIds: [] }));
  const client = { userMessageAction, sessionHistory } as unknown as AcpClient;
  const setComposer = vi.fn();
  const setAttachments = vi.fn();
  const reportError = vi.fn();
  const options = {
    client: () => client, state, workspace: () => "/project", requestMessageEdit, prepareEditedMessage,
    reportError, setPromptText: setComposer, setPromptAttachments: setAttachments, promptRunning: () => running,
    operationRunning: () => operation,
    sessionHistoryLoading: () => false, sessionMutationRunning: () => operation,
    setOperationRunning: (value: boolean) => { operation = value; }, setErrorMessage: vi.fn(),
    markHistoryFullyLoaded: vi.fn(), scrollToLatest: vi.fn(async () => {}),
    refreshSessionState: vi.fn(async () => {}), refreshSessions: vi.fn(async () => {}),
  } as unknown as ConversationBranchActionsOptions;
  return { state, resend, order, requestMessageEdit, prepareEditedMessage, userMessageAction, sessionHistory,
    setComposer, setAttachments, reportError, setRunning: () => { running = true; },
    get operation() { return operation; }, actions: createUserMessageContextActions(options, vi.fn(async () => {})) };
}

describe("edit and resend", () => {
  it("prepares before rewinding, resends without changing the composer", async () => {
    const f = fixture();
    await f.actions.runUserMessageContextAction(message, "edit");
    expect(f.order).toEqual(["prepare", "rewind"]);
    expect(f.resend).toHaveBeenCalledOnce();
    expect(f.setComposer).not.toHaveBeenCalled();
    expect(f.setAttachments).not.toHaveBeenCalled();
    expect(f.operation).toBe(false);
  });

  it("cancel leaves history and composer unchanged", async () => {
    const f = fixture();
    f.requestMessageEdit.mockResolvedValueOnce(undefined);
    const previous = f.state.transcript;
    await f.actions.runUserMessageContextAction(message, "edit");
    expect(f.userMessageAction).not.toHaveBeenCalled();
    expect(f.prepareEditedMessage).not.toHaveBeenCalled();
    expect(f.state.transcript).toBe(previous);
    expect(f.setComposer).not.toHaveBeenCalled();
    expect(f.operation).toBe(false);
  });

  it("stale session, competing prompt and attachment failure never rewind", async () => {
    for (const failure of ["session", "prompt", "attachment"] as const) {
      const f = fixture();
      f.requestMessageEdit.mockImplementationOnce(async () => {
        if (failure === "session") f.state.setSessionId("other");
        if (failure === "prompt") f.setRunning();
        return { text: "edited", attachments: [] };
      });
      if (failure === "attachment") f.prepareEditedMessage.mockRejectedValueOnce(new Error("unavailable image"));
      await f.actions.runUserMessageContextAction(message, "edit");
      expect(f.userMessageAction).not.toHaveBeenCalled();
      expect(f.resend).not.toHaveBeenCalled();
      // A stale completion must not clear the new session's operation state.
      if (failure !== "session") expect(f.operation).toBe(false);
    }
  });

  it("cancelled rewind does not resend or reload history", async () => {
    const f = fixture();
    f.userMessageAction.mockResolvedValueOnce({ status: "cancelled" });
    await f.actions.runUserMessageContextAction(message, "edit");
    expect(f.resend).not.toHaveBeenCalled();
    expect(f.sessionHistory).not.toHaveBeenCalled();
    expect(f.state.transcript).toEqual(emptyTranscript);
    expect(f.operation).toBe(false);
  });
});
