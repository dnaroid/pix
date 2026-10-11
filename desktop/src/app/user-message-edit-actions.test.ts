import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import type { MessageItem } from "../lib/transcript";
import type { ConversationBranchActionsOptions } from "./conversation-branch-options";
import { createActiveSessionState } from "./active-session-state.svelte";
import { createUserMessageContextActions } from "./user-message-context-actions";

const message: MessageItem = { type: "message", id: "row", role: "user", text: "original", attachments: [], sessionEntryId: "user-1" };
function fixture() {
  const state = createActiveSessionState(); state.setSessionId("source"); state.setRuntimeReady(true);
  let running = false;
  const beginMessageEdit = vi.fn(); const userMessageAction = vi.fn(); const reportError = vi.fn();
  const options = { client: () => ({ userMessageAction }) as unknown as AcpClient,
    state, workspace: () => "/project", beginMessageEdit, reportError,
    promptRunning: () => running, operationRunning: () => false, sessionHistoryLoading: () => false,
  } as unknown as ConversationBranchActionsOptions;
  // Client identity is part of the scope contract.
  const client = options.client(); options.client = () => client;
  return { beginMessageEdit, userMessageAction, reportError, state, setRunning: () => { running = true; },
    actions: createUserMessageContextActions(options, vi.fn()) };
}
describe("edit action loads the main composer only", () => {
  it("begins draft editing without RPC, navigation or popup", async () => {
    const f = fixture(); const transcript = f.state.transcript;
    await f.actions.runUserMessageContextAction(message, "edit");
    expect(f.beginMessageEdit).toHaveBeenCalledWith("user-1", message);
    expect(f.userMessageAction).not.toHaveBeenCalled(); expect(f.state.transcript).toBe(transcript);
  });
  it("busy source never begins editing", async () => {
    const f = fixture(); f.setRunning(); await f.actions.runUserMessageContextAction(message, "edit");
    expect(f.beginMessageEdit).not.toHaveBeenCalled(); expect(f.userMessageAction).not.toHaveBeenCalled();
  });
  it("unbound rows fail closed", async () => {
    const f = fixture(); await f.actions.runUserMessageContextAction({ ...message, sessionEntryId: undefined }, "edit");
    expect(f.beginMessageEdit).not.toHaveBeenCalled(); expect(f.reportError).toHaveBeenCalledOnce();
  });
});
