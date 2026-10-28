import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { applySessionUpdates, appendLocalUserMessage, emptyTranscript, type ToolItem } from "./transcript";
import { mergeTranscriptHistory } from "./transcript-history";

const start: SessionUpdate = {
  sessionUpdate: "tool_call", toolCallId: "read-1", name: "read", kind: "read", title: "Read source",
  status: "in_progress", rawInput: { path: "src/main.ts" },
};
const finish: SessionUpdate = {
  sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed",
  content: [{ type: "content", content: { type: "text", text: "source body" } }],
};

describe("history snapshot merging", () => {
  it("keeps a live completion and persisted input at the history position", () => {
    const history = applySessionUpdates(emptyTranscript, [
      { sessionUpdate: "user_message_chunk", messageId: "replay-entry:1", content: { type: "text", text: "old prompt" } },
      start,
    ]);
    const live = appendLocalUserMessage(applySessionUpdates(emptyTranscript, [finish]), "new prompt", "local:1");
    const merged = mergeTranscriptHistory(history, live);
    expect(merged.items.map((item) => item.id)).toEqual(["user:replay-entry:1", "tool:read-1", "local:1"]);
    expect(merged.items[1]).toMatchObject({
      name: "read", kind: "read", title: "Read source", rawInput: { path: "src/main.ts" },
      status: "completed", content: "source body",
    });
    expect(history.items[1]).toMatchObject({ status: "in_progress", content: "" });
  });

  it("does not revive a persisted completion from a cached start", () => {
    const history = applySessionUpdates(emptyTranscript, [start, finish]);
    const current = applySessionUpdates(emptyTranscript, [start]);
    expect(mergeTranscriptHistory(history, current).items).toMatchObject([
      { status: "completed", content: "source body", rawInput: { path: "src/main.ts" } },
    ]);
  });

  it("retains lazy-result ownership unless the live cache already has its body", () => {
    const base = applySessionUpdates(emptyTranscript, [start]).items[0] as ToolItem;
    const history = { items: [{ ...base, status: "completed" as const, deferredResult: true }] };
    const pending = applySessionUpdates(emptyTranscript, [start]);
    expect(mergeTranscriptHistory(history, pending).items[0]).toMatchObject({ status: "completed", deferredResult: true });
    const hydrated = applySessionUpdates(emptyTranscript, [start, finish]);
    expect(mergeTranscriptHistory(history, hydrated).items[0]).toMatchObject({ content: "source body", deferredResult: false });
  });

  it("does not append text twice when rehydrating an overlapping cached page", () => {
    const message = (text: string): SessionUpdate => ({
      sessionUpdate: "agent_message_chunk", messageId: "replay-entry:1", content: { type: "text", text },
    });
    const history = applySessionUpdates(emptyTranscript, [message("saved text")]);
    const cached = applySessionUpdates(emptyTranscript, [message("saved text and more")]);
    expect(mergeTranscriptHistory(history, cached).items).toMatchObject([{ text: "saved text and more" }]);
    expect(mergeTranscriptHistory(cached, history).items).toMatchObject([{ text: "saved text and more" }]);
    expect(mergeTranscriptHistory(history, history).items).toHaveLength(1);
  });
});
