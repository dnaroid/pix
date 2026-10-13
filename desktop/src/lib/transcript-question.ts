import type { MessageItem, ToolItem } from "./transcript-types";

/** Presentation only: questions and answers never enqueue additional prompts. */
export function questionTranscriptMessages(tool: ToolItem): MessageItem[] {
  if (tool.name !== "question") return [];
  const input = isRecord(tool.rawInput) && Array.isArray(tool.rawInput.questions)
    ? tool.rawInput.questions : [];
  const answers = questionAnswers(tool);
  const messages: MessageItem[] = [];
  for (const question of input) {
    if (!isRecord(question) || typeof question.id !== "string") continue;
    const prompt = typeof question.prompt === "string" && question.prompt.trim()
      ? question.prompt
      : typeof question.label === "string" && question.label !== question.id ? question.label : "";
    if (prompt) messages.push({
      type: "message",
      id: `question-prompt:${tool.toolCallId}:${question.id}`,
      role: "assistant",
      text: prompt,
      attachments: [],
      localOnly: true,
    });
    const answer = answers.get(question.id);
    if (answer) {
      messages.push(answer);
      answers.delete(question.id);
    }
  }
  // Older/incomplete history can lack tool input. Never expose internal IDs as prose.
  messages.push(...answers.values());
  return messages;
}

function questionAnswers(tool: ToolItem): Map<string, MessageItem> {
  const messages = new Map<string, MessageItem>();
  const result = tool.rawOutput;
  if (tool.status !== "completed" || !isRecord(result) || result.canceled !== false || !Array.isArray(result.answers)) return messages;
  const images = tool.attachments.filter((attachment) => attachment.kind === "image");
  let imageOffset = 0;
  for (const answer of result.answers) {
    if (!isRecord(answer) || typeof answer.id !== "string" || messages.has(answer.id)) return new Map();
    const selections = answer.multiple === true ? answer.selections : [answer];
    if (!Array.isArray(selections) || selections.length === 0) return new Map();
    const labels: string[] = [];
    let imageCount = 0;
    for (const selection of selections) {
      if (!isRecord(selection) || typeof selection.label !== "string" || !selection.label.trim()) return new Map();
      labels.push(selection.label);
      if (typeof selection.imageCount === "number" && Number.isInteger(selection.imageCount) && selection.imageCount > 0) {
        imageCount += selection.imageCount;
      }
    }
    messages.set(answer.id, {
      type: "message",
      id: `question-answer:${tool.toolCallId}:${answer.id}`,
      role: "user",
      text: labels.join("; "),
      attachments: images.slice(imageOffset, imageOffset + imageCount),
      localOnly: true,
    });
    imageOffset += imageCount;
  }
  return messages;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
