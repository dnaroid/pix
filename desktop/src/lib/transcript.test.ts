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
      name: "Write",
      title: "Write file",
      kind: "edit",
      status: "in_progress",
      rawInput: { path: "file" },
      locations: [{ path: "/workspace/file.ts" }],
    });
    state = applySessionUpdate(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "ok" } }],
      rawOutput: { diff: "-old\n+new" },
    });

    expect(state.items).toEqual([
      expect.objectContaining({
        type: "tool",
        name: "Write",
        title: "Write file",
        status: "completed",
        rawInput: { path: "file" },
        content: "ok",
        rawOutput: { diff: "-old\n+new" },
        path: "/workspace/file.ts",
      }),
    ]);
  });

  it("keeps image chunks and persisted file markers as message attachments", () => {
    let state = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "user_message_chunk",
      messageId: "message-1",
      content: { type: "text", text: "Review\n\n[Pix attachment: file:///tmp/demo.mp4]" },
    });
    state = applySessionUpdate(state, {
      sessionUpdate: "user_message_chunk",
      messageId: "message-1",
      content: { type: "image", data: "aGk=", mimeType: "image/png" },
    });

    expect(state.items).toEqual([
      expect.objectContaining({
        type: "message",
        text: "Review",
        attachments: [
          expect.objectContaining({ kind: "video", path: "/tmp/demo.mp4" }),
          expect.objectContaining({ kind: "image", dataUrl: "data:image/png;base64,aGk=" }),
        ],
      }),
    ]);
  });

  it("keeps image tool output separate from textual output", () => {
    const state = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call",
      toolCallId: "tool-image",
      title: "Screenshot",
      content: [
        { type: "content", content: { type: "text", text: "captured" } },
        { type: "content", content: { type: "image", data: "aGk=", mimeType: "image/png" } },
      ],
    });

    expect(state.items[0]).toMatchObject({
      type: "tool",
      content: "captured",
      diffs: [],
      attachments: [{ kind: "image", dataUrl: "data:image/png;base64,aGk=" }],
    });
  });

  it("keeps structured edit diffs separate from textual tool output", () => {
    const state = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-edit",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "Updated file" } },
        { type: "diff", path: "/repo/a.ts", oldText: "old", newText: "new" },
      ],
    });

    expect(state.items[0]).toMatchObject({
      type: "tool",
      content: "Updated file",
      diffs: [{ path: "/repo/a.ts", oldText: "old", newText: "new" }],
    });
  });

  it("preserves ordered mutation result blocks for LSP and comment-checker output", () => {
    const state = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-mutation",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "Success. Updated a.ts" } },
        { type: "content", content: { type: "text", text: "LSP diagnostics:\n\n✅ typescript: no diagnostics" } },
        { type: "content", content: { type: "text", text: "💬 comment-checker — unnecessary comments\na.ts  4:filler" } },
      ],
    });

    expect(state.items[0]).toMatchObject({
      content: [
        "Success. Updated a.ts",
        "LSP diagnostics:\n\n✅ typescript: no diagnostics",
        "💬 comment-checker — unnecessary comments\na.ts  4:filler",
      ].join("\n"),
    });
  });
});

describe("transcript display groups", () => {
  it("groups consecutive tools and starts a new group after a message", () => {
    const first = toolItem("one");
    const second = toolItem("two");
    const third = toolItem("three");
    const message = { type: "message", id: "assistant:1", role: "assistant", text: "Next", attachments: [] } as const;

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
      { type: "message", id: "break:1", role: "assistant", text: "break", attachments: [] },
      toolItem("running", "in_progress"),
      { type: "message", id: "break:2", role: "assistant", text: "break", attachments: [] },
      toolItem("failed", "failed"),
      toolItem("still-pending", "pending"),
      { type: "message", id: "break:3", role: "assistant", text: "break", attachments: [] },
      toolItem("completed", "completed"),
    ]).filter((item) => item.type === "tool-group");

    expect(pendingGroup).toMatchObject({ status: "pending", active: true });
    expect(runningGroup).toMatchObject({ status: "in_progress", active: true });
    expect(failedGroup).toMatchObject({ status: "failed", active: true });
    expect(completedGroup).toMatchObject({ status: "completed", active: false });
  });

  it("hides redundant image labels when previews are present", () => {
    const message = {
      type: "message",
      id: "user:1",
      role: "user",
      text: "Check this\n\n[Image 1]",
      attachments: [{
        id: "image:1",
        name: "image.png",
        kind: "image",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,aGk=",
      }],
    } as const;

    expect(groupTranscriptItems([message])[0]).toMatchObject({ text: "Check this" });
  });

  it("preserves image labels when no matching preview is present", () => {
    const message = {
      type: "message",
      id: "user:1",
      role: "user",
      text: "[Image 1]",
      attachments: [],
    } as const;

    expect(groupTranscriptItems([message])[0]).toBe(message);
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
    diffs: [],
    attachments: [],
  };
}
