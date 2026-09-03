import type { ContentBlock, SessionUpdate, ToolCallContent, ToolCallStatus } from "@agentclientprotocol/sdk";

export type MessageRole = "user" | "assistant" | "thought";

export interface MessageItem {
  readonly type: "message";
  readonly id: string;
  readonly messageId?: string;
  readonly role: MessageRole;
  readonly text: string;
}

export interface ToolItem {
  readonly type: "tool";
  readonly id: string;
  readonly toolCallId: string;
  readonly title: string;
  readonly kind: string;
  readonly status: ToolCallStatus;
  readonly content: string;
}

export type TranscriptItem = MessageItem | ToolItem;

export interface ToolGroupItem {
  readonly type: "tool-group";
  readonly id: string;
  readonly tools: readonly [ToolItem, ...ToolItem[]];
  readonly status: ToolCallStatus;
  readonly active: boolean;
}

export type TranscriptDisplayItem = MessageItem | ToolGroupItem;

export interface TranscriptState {
  readonly items: readonly TranscriptItem[];
}

export const emptyTranscript: TranscriptState = { items: [] };

export function groupTranscriptItems(items: readonly TranscriptItem[]): TranscriptDisplayItem[] {
  const grouped: TranscriptDisplayItem[] = [];

  for (const item of items) {
    if (item.type === "message") {
      grouped.push(item);
      continue;
    }

    const previous = grouped.at(-1);
    if (previous?.type === "tool-group") {
      const tools: [ToolItem, ...ToolItem[]] = [...previous.tools, item];
      grouped[grouped.length - 1] = buildToolGroup(tools);
    } else {
      grouped.push(buildToolGroup([item]));
    }
  }

  return grouped;
}

export function appendLocalUserMessage(state: TranscriptState, text: string, id: string): TranscriptState {
  return {
    items: [...state.items, { type: "message", id, role: "user", text }],
  };
}

export function applySessionUpdate(state: TranscriptState, update: SessionUpdate): TranscriptState {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return appendContentChunk(state, "user", update.messageId ?? undefined, update.content);
    case "agent_message_chunk":
      return appendContentChunk(state, "assistant", update.messageId ?? undefined, update.content);
    case "agent_thought_chunk":
      return appendContentChunk(state, "thought", update.messageId ?? undefined, update.content);
    case "tool_call":
      return upsertTool(state, update.toolCallId, {
        title: update.title,
        kind: update.kind ?? "other",
        status: update.status ?? "pending",
        content: toolContentText(update.content),
      });
    case "tool_call_update":
      return upsertTool(state, update.toolCallId, {
        ...(update.title != null ? { title: update.title } : {}),
        ...(update.kind != null ? { kind: update.kind } : {}),
        ...(update.status != null ? { status: update.status } : {}),
        ...(update.content != null ? { content: toolContentText(update.content) } : {}),
      });
    default:
      return state;
  }
}

function appendContentChunk(
  state: TranscriptState,
  role: MessageRole,
  messageId: string | undefined,
  content: ContentBlock,
): TranscriptState {
  const text = contentBlockText(content);
  if (!text) return state;

  const items = [...state.items];
  const existingIndex = messageId
    ? items.findIndex((item) => item.type === "message" && item.role === role && item.messageId === messageId)
    : items.length - 1;
  const existing = items[existingIndex];
  const canAppend = existing?.type === "message"
    && existing.role === role
    && (messageId ? existing.messageId === messageId : existing.messageId === undefined);

  if (canAppend) {
    items[existingIndex] = { ...existing, text: existing.text + text };
  } else {
    items.push({
      type: "message",
      id: messageId ? `${role}:${messageId}` : `${role}:chunk:${items.length}`,
      ...(messageId ? { messageId } : {}),
      role,
      text,
    });
  }
  return { items };
}

function upsertTool(
  state: TranscriptState,
  toolCallId: string,
  patch: Partial<Pick<ToolItem, "title" | "kind" | "status" | "content">>,
): TranscriptState {
  const items = [...state.items];
  const index = items.findIndex((item) => item.type === "tool" && item.toolCallId === toolCallId);
  if (index >= 0) {
    const existing = items[index] as ToolItem;
    items[index] = { ...existing, ...patch };
  } else {
    items.push({
      type: "tool",
      id: `tool:${toolCallId}`,
      toolCallId,
      title: patch.title ?? "Tool call",
      kind: patch.kind ?? "other",
      status: patch.status ?? "pending",
      content: patch.content ?? "",
    });
  }
  return { items };
}

function buildToolGroup(tools: readonly [ToolItem, ...ToolItem[]]): ToolGroupItem {
  const active = tools.some((tool) => tool.status === "pending" || tool.status === "in_progress");
  let status: ToolCallStatus = "completed";
  if (tools.some((tool) => tool.status === "failed")) {
    status = "failed";
  } else if (tools.some((tool) => tool.status === "in_progress")) {
    status = "in_progress";
  } else if (tools.some((tool) => tool.status === "pending")) {
    status = "pending";
  }

  return {
    type: "tool-group",
    id: `tool-group:${tools[0].toolCallId}`,
    tools,
    status,
    active,
  };
}

function contentBlockText(content: ContentBlock): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    case "resource_link":
      return content.uri;
    case "resource":
      return "[resource]";
  }
}

function toolContentText(content: readonly ToolCallContent[] | null | undefined): string {
  if (!content) return "";
  return content.map((item) => {
    if (item.type === "content") return contentBlockText(item.content);
    if (item.type === "diff") return `${item.path}\n${item.newText}`;
    return `[terminal ${item.terminalId}]`;
  }).join("\n");
}
