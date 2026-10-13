import { describe, expect, it } from "vitest";
import { applySessionUpdates, emptyTranscript, groupTranscriptItems, type ToolItem } from "./transcript";
import { questionTranscriptMessages } from "./transcript-question";

const input = { questions: [
  { id: "target", label: "Платформа", prompt: "На какой платформе проверять?" },
  { id: "details", label: "Детали", prompt: "Что включить в проверку?" },
] };
const result = { canceled: false, answers: [
  { id: "target", label: "Desktop", value: "desktop", wasCustom: false, index: 1 },
  { id: "details", multiple: true, selections: [
    { label: "Текст", value: "text", wasCustom: false, index: 1 },
    { label: "Мой ответ\nс продолжением", value: "custom", wasCustom: true },
  ] },
] };

function transcript(output: unknown = result, status: "completed" | "failed" = "completed") {
  return applySessionUpdates(emptyTranscript, [
    { sessionUpdate: "tool_call", toolCallId: "q1", name: "question", title: "question", rawInput: input, status: "in_progress" },
    { sessionUpdate: "tool_call_update", toolCallId: "q1", status, rawOutput: output },
    { sessionUpdate: "agent_message_chunk", messageId: "a1", content: { type: "text", text: "Принято" } },
  ]);
}

describe("question answer transcript presentation", () => {
  it("places full assistant questions and user answers in alternating pairs before continuation", () => {
    const state = transcript();
    const grouped = groupTranscriptItems(state.items);
    expect(grouped.map((item) => item.type)).toEqual(["activity-group", "message", "message", "message", "message", "message"]);
    expect(grouped.slice(1, 5)).toMatchObject([
      { id: "question-prompt:q1:target", role: "assistant", text: "На какой платформе проверять?" },
      { id: "question-answer:q1:target", role: "user", localOnly: true, text: "Desktop" },
      { id: "question-prompt:q1:details", role: "assistant", text: "Что включить в проверку?" },
      { id: "question-answer:q1:details", role: "user", localOnly: true, text: "Текст; Мой ответ\nс продолжением" },
    ]);
    expect(groupTranscriptItems(state.items)).toEqual(grouped);
    expect(state.items).toHaveLength(2);
  });

  it("does not duplicate answers after repeated completion updates", () => {
    const state = applySessionUpdates(transcript(), [
      { sessionUpdate: "tool_call_update", toolCallId: "q1", status: "completed", rawOutput: result },
    ]);
    expect(groupTranscriptItems(state.items).filter((item) => item.type === "message" && item.role === "user")).toHaveLength(2);
  });

  it.each([{ canceled: true, answers: [] }, { canceled: false, answers: [] },
    { canceled: false, answers: [{ id: "target" }] }, null])("ignores cancellation or malformed output: %j", (output) => {
    const grouped = groupTranscriptItems(transcript(output).items);
    expect(grouped).toHaveLength(4);
    expect(grouped.some((item) => item.type === "message" && item.role === "user")).toBe(false);
  });

  it("ignores failed and unrelated tools", () => {
    expect(groupTranscriptItems(transcript(result, "failed").items)).toHaveLength(4);
    expect(questionTranscriptMessages({ ...transcript().items[0] as ToolItem, name: "other" })).toEqual([]);
  });

  it("retains image-only answers as user attachments", () => {
    const tool = transcript().items[0] as ToolItem;
    const image = { id: "image", name: "image.png", mimeType: "image/png", kind: "image" as const, dataUrl: "data:image/png;base64,QUJDRA==" };
    const messages = questionTranscriptMessages({ ...tool, rawOutput: { canceled: false, answers: [{ id: "target", label: "1 image attached", wasCustom: true, imageCount: 1 }] }, attachments: [image] });
    expect(messages[1]?.attachments).toEqual([image]);
    expect(messages[0]?.attachments).toEqual([]);
  });

  it("shows questions while waiting, without an invented answer", () => {
    const tool = transcript().items[0] as ToolItem;
    expect(questionTranscriptMessages({ ...tool, status: "in_progress" }).map((item) => item.role)).toEqual(["assistant", "assistant"]);
  });

  it("uses questionnaire order even when answer results are reordered", () => {
    const tool = transcript().items[0] as ToolItem;
    const messages = questionTranscriptMessages({ ...tool, rawOutput: { ...result, answers: [...result.answers].reverse() } });
    expect(messages.map((item) => item.text)).toEqual([
      "На какой платформе проверять?", "Desktop", "Что включить в проверку?", "Текст; Мой ответ\nс продолжением",
    ]);
  });

  it("does not expose IDs when question input is absent", () => {
    const tool = transcript().items[0] as ToolItem;
    expect(questionTranscriptMessages({ ...tool, rawInput: undefined }).map((item) => item.text)).toEqual(["Desktop", "Текст; Мой ответ\nс продолжением"]);
  });

  it("assigns images only to their matching answer", () => {
    const tool = transcript().items[0] as ToolItem;
    const images = ["first", "second"].map((id) => ({ id, name: `${id}.png`, kind: "image" as const, mimeType: "image/png" }));
    const messages = questionTranscriptMessages({ ...tool, attachments: images, rawOutput: { canceled: false, answers: [
      { id: "target", label: "Первое фото", wasCustom: true, imageCount: 1 },
      { id: "details", multiple: true, selections: [{ label: "Второе фото", wasCustom: true, imageCount: 1 }] },
    ] } });
    expect(messages[1]?.attachments).toEqual([images[0]]);
    expect(messages[3]?.attachments).toEqual([images[1]]);
  });
});
