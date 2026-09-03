import { describe, expect, it } from "vitest";
import {
  appendLocalUserMessage,
  applySessionUpdate,
  emptyTranscript,
  groupTranscriptItems,
  type ToolItem,
} from "./transcript";

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

describe("transcript display groups", () => {
  it("groups consecutive tools and starts a new group after a message", () => {
    const first = toolItem("one");
    const second = toolItem("two");
    const third = toolItem("three");
    const message = { type: "message", id: "assistant:1", role: "assistant", text: "Next" } as const;

    const grouped = groupTranscriptItems([first, second, message, third]);

    expect(grouped).toHaveLength(3);
    expect(grouped[0]).toMatchObject({
      type: "tool-group",
      id: "tool-group:one",
      tools: [first, second],
    });
    expect(grouped[1]).toBe(message);
    expect(grouped[2]).toMatchObject({
      type: "tool-group",
      id: "tool-group:three",
      tools: [third],
    });
  });

  it("marks pending and running groups active while preserving failures", () => {
    const [pendingGroup, runningGroup, failedGroup, completedGroup] = groupTranscriptItems([
      toolItem("pending", "pending"),
      { type: "message", id: "break:1", role: "assistant", text: "break" },
      toolItem("running", "in_progress"),
      { type: "message", id: "break:2", role: "assistant", text: "break" },
      toolItem("failed", "failed"),
      toolItem("still-pending", "pending"),
      { type: "message", id: "break:3", role: "assistant", text: "break" },
      toolItem("completed", "completed"),
    ]).filter((item) => item.type === "tool-group");

    expect(pendingGroup).toMatchObject({ status: "pending", active: true });
    expect(runningGroup).toMatchObject({ status: "in_progress", active: true });
    expect(failedGroup).toMatchObject({ status: "failed", active: true });
    expect(completedGroup).toMatchObject({ status: "completed", active: false });
  });
});

function toolItem(toolCallId: string, status: ToolItem["status"] = "completed"): ToolItem {
  return {
    type: "tool",
    id: `tool:${toolCallId}`,
    toolCallId,
    title: toolCallId,
    kind: "other",
    status,
    content: "",
  };
}
