import type { ContentBlock, SessionUpdate, ToolCallContent, ToolCallStatus } from "@agentclientprotocol/sdk";
import {
  attachmentFromFile,
  attachmentFromImage,
  extractAttachmentMarkers,
  fileNameFromPath,
  filePathFromUri,
  type Attachment,
} from "./attachments";
import type { ToolDiff } from "./diff";

export type MessageRole = "user" | "assistant" | "thought";

export interface MessageItem {
  readonly type: "message";
  readonly id: string;
  readonly messageId?: string;
  readonly role: MessageRole;
  readonly text: string;
  readonly attachments: readonly Attachment[];
}

export interface ToolItem {
  readonly type: "tool";
  readonly id: string;
  readonly toolCallId: string;
  readonly name?: string;
  readonly title: string;
  readonly kind: string;
  readonly status: ToolCallStatus;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly content: string;
  readonly diffs: readonly ToolDiff[];
  readonly attachments: readonly Attachment[];
  readonly path?: string;
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
      grouped.push(messageForDisplay(item));
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

function messageForDisplay(item: MessageItem): MessageItem {
  if (item.role !== "user") return item;
  const imageCount = item.attachments.filter((attachment) => attachment.kind === "image").length;
  if (imageCount === 0) return item;

  const text = item.text
    .replace(/^\[Image (\d+)\][ \t]*\r?$/gm, (marker, index: string) =>
      Number(index) <= imageCount ? "" : marker)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text === item.text ? item : { ...item, text };
}

export function appendLocalUserMessage(
  state: TranscriptState,
  text: string,
  id: string,
  attachments: readonly Attachment[] = [],
): TranscriptState {
  return {
    items: [...state.items, { type: "message", id, role: "user", text, attachments }],
  };
}

export function appendLocalAssistantMessage(state: TranscriptState, text: string, id: string): TranscriptState {
  return {
    items: [...state.items, { type: "message", id, role: "assistant", text, attachments: [] }],
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
    case "tool_call": {
      const initialContent = toolContent(update.content, `tool:${update.toolCallId}`);
      return upsertTool(state, update.toolCallId, {
        ...(update.name != null ? { name: update.name } : {}),
        title: update.title,
        kind: update.kind ?? "other",
        status: update.status ?? "pending",
        ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
        ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
        content: initialContent.text,
        diffs: initialContent.diffs,
        attachments: initialContent.attachments,
        path: update.locations?.[0]?.path,
      });
    }
    case "tool_call_update": {
      const nextContent = update.content != null
        ? toolContent(update.content, `tool:${update.toolCallId}`)
        : undefined;
      return upsertTool(state, update.toolCallId, {
        ...(update.name != null ? { name: update.name } : {}),
        ...(update.title != null ? { title: update.title } : {}),
        ...(update.kind != null ? { kind: update.kind } : {}),
        ...(update.status != null ? { status: update.status } : {}),
        ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
        ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
        ...(nextContent ? {
          content: nextContent.text,
          diffs: nextContent.diffs,
          attachments: nextContent.attachments,
        } : {}),
        ...(update.locations != null ? { path: update.locations[0]?.path } : {}),
      });
    }
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
  const items = [...state.items];
  const existingIndex = messageId
    ? items.findIndex((item) => item.type === "message" && item.role === role && item.messageId === messageId)
    : items.length - 1;
  const existing = items[existingIndex];
  const canAppend = existing?.type === "message"
    && existing.role === role
    && (messageId ? existing.messageId === messageId : existing.messageId === undefined);
  const id = messageId ? `${role}:${messageId}` : `${role}:chunk:${items.length}`;
  const attachmentOffset = canAppend ? existing.attachments.length : 0;
  const chunk = messageContent(content, role, id, attachmentOffset);
  if (!chunk.text && chunk.attachments.length === 0) return state;

  if (canAppend) {
    items[existingIndex] = {
      ...existing,
      text: existing.text + chunk.text,
      attachments: [...existing.attachments, ...chunk.attachments],
    };
  } else {
    items.push({
      type: "message",
      id,
      ...(messageId ? { messageId } : {}),
      role,
      text: chunk.text,
      attachments: chunk.attachments,
    });
  }
  return { items };
}

function upsertTool(
  state: TranscriptState,
  toolCallId: string,
  patch: Partial<Pick<ToolItem, "name" | "title" | "kind" | "status" | "rawInput" | "rawOutput" | "content" | "diffs" | "attachments" | "path">>,
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
      ...(patch.name ? { name: patch.name } : {}),
      title: patch.title ?? "Tool call",
      kind: patch.kind ?? "other",
      status: patch.status ?? "pending",
      ...(patch.rawInput !== undefined ? { rawInput: patch.rawInput } : {}),
      ...(patch.rawOutput !== undefined ? { rawOutput: patch.rawOutput } : {}),
      content: patch.content ?? "",
      diffs: patch.diffs ?? [],
      attachments: patch.attachments ?? [],
      ...(patch.path ? { path: patch.path } : {}),
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

function messageContent(
  content: ContentBlock,
  role: MessageRole,
  idPrefix: string,
  attachmentOffset: number,
): { text: string; attachments: Attachment[] } {
  switch (content.type) {
    case "text":
      return role === "user"
        ? extractAttachmentMarkers(content.text, idPrefix, attachmentOffset)
        : { text: content.text, attachments: [] };
    case "image":
      return {
        text: "",
        attachments: [attachmentFromImage(
          content.data,
          content.mimeType,
          `${idPrefix}:attachment:${attachmentOffset}`,
          content.uri,
        )],
      };
    case "audio":
      return { text: "[audio]", attachments: [] };
    case "resource_link": {
      const path = filePathFromUri(content.uri);
      if (!path) return { text: content.uri, attachments: [] };
      const name = content.name || fileNameFromPath(path);
      return {
        text: "",
        attachments: [attachmentFromFile(
          { path, name, size: content.size ?? 0 },
          `${idPrefix}:attachment:${attachmentOffset}`,
        )],
      };
    }
    case "resource":
      return { text: "[resource]", attachments: [] };
  }
}

function toolContent(
  content: readonly ToolCallContent[] | null | undefined,
  idPrefix: string,
): { text: string; diffs: ToolDiff[]; attachments: Attachment[] } {
  if (!content) return { text: "", diffs: [], attachments: [] };
  const text: string[] = [];
  const diffs: ToolDiff[] = [];
  const attachments: Attachment[] = [];
  for (const item of content) {
    if (item.type === "content") {
      const next = messageContent(item.content, "assistant", idPrefix, attachments.length);
      if (next.text) text.push(next.text);
      attachments.push(...next.attachments);
    } else if (item.type === "diff") {
      diffs.push({
        path: item.path,
        ...(item.oldText === undefined ? {} : { oldText: item.oldText }),
        newText: item.newText,
      });
    } else {
      text.push(`[terminal ${item.terminalId}]`);
    }
  }
  return { text: text.join("\n"), diffs, attachments };
}
