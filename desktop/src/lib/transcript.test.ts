import { describe, expect, it } from "vitest";
import {
  appendLocalUserMessage,
  applyDeferredToolResult,
  applySessionUpdate,
  applySessionUpdates,
  emptyTranscript,
  groupTranscriptItems,
  hydrateTranscriptAttachment,
  markDeferredToolResults,
  setToolResultLoading,
  type ToolItem,
} from "./transcript";

describe("transcript reducer", () => {
  it("marks Pix system feedback as a system message without affecting normal assistant messages", () => {
    const state = applySessionUpdates(emptyTranscript, [
      { sessionUpdate: "agent_message_chunk", messageId: "pix-system:one", content: { type: "text", text: "Reloaded resources" } },
      { sessionUpdate: "agent_message_chunk", messageId: "assistant-one", content: { type: "text", text: "Normal answer" } },
    ]);

    expect(state.items[0]).toMatchObject({ type: "message", role: "system", text: "Reloaded resources" });
    expect(state.items[1]).toMatchObject({ type: "message", role: "assistant", text: "Normal answer" });
  });

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

  it("keeps deferred history images lightweight until hydrated", () => {
    let state = applySessionUpdate(emptyTranscript, {
      sessionUpdate: "user_message_chunk",
      messageId: "message-1",
      content: {
        type: "resource_link",
        uri: "pix-deferred-image:replay-1%3Aimage%3A0",
        name: "image-1.png",
        mimeType: "image/png",
      },
    });

    const attachment = state.items[0]?.attachments[0];
    expect(attachment).toMatchObject({
      kind: "image",
      deferredImageId: "replay-1:image:0",
    });
    expect(attachment?.dataUrl).toBeUndefined();

    state = hydrateTranscriptAttachment(state, attachment!.id, "data:image/png;base64,aGk=", "image/png");
    expect(state.items[0]?.attachments[0]).toMatchObject({
      deferredImageId: "replay-1:image:0",
      dataUrl: "data:image/png;base64,aGk=",
    });
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

  it("builds history batches in order while coalescing stable message ids", () => {
    const state = applySessionUpdates(emptyTranscript, [
      { sessionUpdate: "agent_message_chunk", messageId: "a1", content: { type: "text", text: "one" } },
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", status: "completed" },
      { sessionUpdate: "agent_message_chunk", messageId: "a1", content: { type: "text", text: " two" } },
    ]);

    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({ type: "message", messageId: "a1", text: "one two" });
    expect(state.items[1]).toMatchObject({ type: "tool", toolCallId: "t1" });
  });

  it("applies a live batch to an existing transcript without losing tool UI state", () => {
    let state = applySessionUpdates(emptyTranscript, [
      { sessionUpdate: "agent_message_chunk", messageId: "a1", content: { type: "text", text: "before" } },
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", status: "in_progress" },
    ]);
    state = markDeferredToolResults(state, ["t1"]);

    state = applySessionUpdates(state, [
      { sessionUpdate: "agent_message_chunk", messageId: "a1", content: { type: "text", text: " after" } },
      { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
    ]);

    expect(state.items[0]).toMatchObject({ type: "message", messageId: "a1", text: "before after" });
    expect(state.items[1]).toMatchObject({
      type: "tool",
      toolCallId: "t1",
      status: "completed",
      deferredResult: true,
    });
  });

  it("hydrates deferred tool results only when the full update arrives", () => {
    let state = applySessionUpdates(emptyTranscript, [
      {
        sessionUpdate: "tool_call",
        toolCallId: "lazy-1",
        name: "Edit",
        title: "Edit file.ts",
        kind: "edit",
        status: "in_progress",
      },
      { sessionUpdate: "tool_call_update", toolCallId: "lazy-1", status: "completed" },
    ]);
    state = markDeferredToolResults(state, ["lazy-1"]);

    expect(state.items[0]).toMatchObject({
      type: "tool",
      toolCallId: "lazy-1",
      status: "completed",
      deferredResult: true,
      content: "",
    });
    expect((state.items[0] as ToolItem).rawInput).toBeUndefined();

    state = setToolResultLoading(state, "lazy-1", true);
    expect(state.items[0]).toMatchObject({ resultLoading: true });

    state = applyDeferredToolResult(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "lazy-1",
      status: "completed",
      rawInput: { path: "file.ts" },
      rawOutput: { changed: true },
      content: [{ type: "content", content: { type: "text", text: "updated" } }],
    });
    expect(state.items[0]).toMatchObject({
      deferredResult: false,
      resultLoading: false,
      rawInput: { path: "file.ts" },
      rawOutput: { changed: true },
      content: "updated",
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
