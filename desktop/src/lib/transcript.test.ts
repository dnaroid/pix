import { describe, expect, it } from "vitest";
import { appendLocalUserMessage, applySessionUpdate, emptyTranscript } from "./transcript";

describe("transcript reducer", () => {
  it("coalesces adjacent id-less chunks but starts a message after a tool", () => {
    let state = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello" },
    });
    state = applySessionUpdate(state, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " world" },
    });
    state = applySessionUpdate(state, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Read a file",
      status: "in_progress",
    });
    state = applySessionUpdate(state, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Done" },
    });

    expect(state.items).toHaveLength(3);
    expect(state.items[0]).toMatchObject({ type: "message", text: "Hello world" });
    expect(state.items[2]).toMatchObject({ type: "message", text: "Done" });
  });

  it("coalesces non-adjacent chunks that share a message id", () => {
    let state = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "agent_thought_chunk",
      messageId: "thought-1",
      content: { type: "text", text: "First" },
    });
    state = appendLocalUserMessage(state, "interrupt", "local-1");
    state = applySessionUpdate(state, {
      sessionUpdate: "agent_thought_chunk",
      messageId: "thought-1",
      content: { type: "text", text: " second" },
    });

    expect(state.items[0]).toMatchObject({ text: "First second", messageId: "thought-1" });
    expect(state.items).toHaveLength(2);
  });

  it("merges tool updates into the original item", () => {
    let state = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Write file",
      kind: "edit",
      status: "in_progress",
    });
    state = applySessionUpdate(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "ok" } }],
    });

    expect(state.items).toEqual([
      expect.objectContaining({
        type: "tool",
        title: "Write file",
        status: "completed",
        content: "ok",
      }),
    ]);
  });
});
