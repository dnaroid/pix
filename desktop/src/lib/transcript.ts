import type { ContentBlock, SessionUpdate, ToolCallContent, ToolCallStatus } from "@agentclientprotocol/sdk";
import {
  attachmentFromDeferredImage,
  attachmentFromFile,
  attachmentFromImage,
  extractAttachmentMarkers,
  fileNameFromPath,
  filePathFromUri,
  type Attachment,
} from "./attachments";
import type { ToolDiff } from "./diff";

export type MessageRole = "user" | "assistant" | "thought" | "system";
const PIX_ACTIVITY_TIMING_META_KEY = "pix.activityTiming";

interface ActivityTimingMeta {
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
}

export interface MessageItem {
  readonly type: "message";
  readonly id: string;
  readonly messageId?: string;
  readonly role: MessageRole;
  readonly text: string;
  readonly attachments: readonly Attachment[];
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
  readonly sessionEntryId?: string;
  /** Renderer-only user row that has no corresponding Pi session entry. */
  readonly localOnly?: boolean;
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
  readonly deferredResult?: boolean;
  readonly resultLoading?: boolean;
  readonly resultError?: string;
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
}

export type TranscriptItem = MessageItem | ToolItem;

export interface ToolGroupItem {
  readonly type: "tool-group";
  readonly id: string;
  readonly tools: readonly [ToolItem, ...ToolItem[]];
  readonly status: ToolCallStatus;
  readonly active: boolean;
  readonly durationMs?: number;
}

export type TranscriptDisplayItem = MessageItem | ToolGroupItem;

export interface TranscriptState {
  readonly items: readonly TranscriptItem[];
}

export const emptyTranscript: TranscriptState = { items: [] };

export function hydrateTranscriptAttachment(
  state: TranscriptState,
  attachmentId: string,
  dataUrl: string,
  mimeType?: string,
): TranscriptState {
  let changed = false;
  const items = state.items.map((item) => {
    if (!item.attachments.some((attachment) => attachment.id === attachmentId)) return item;
    const attachments = item.attachments.map((attachment) => {
      if (attachment.id !== attachmentId) return attachment;
      changed = true;
      return { ...attachment, dataUrl, ...(mimeType ? { mimeType } : {}) };
    });
    return { ...item, attachments };
  });
  return changed ? { items } : state;
}

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
  options: { localOnly?: boolean } = {},
): TranscriptState {
  return {
    items: [
      ...state.items,
      {
        type: "message",
        id,
        role: "user",
        text,
        attachments,
        ...(options.localOnly ? { localOnly: true } : {}),
      },
    ],
  };
}

export function appendLocalSystemMessage(state: TranscriptState, text: string, id: string): TranscriptState {
  return {
    items: [...state.items, { type: "message", id, role: "system", text, attachments: [] }],
  };
}

export function bindLocalUserMessageSessionEntry(
  state: TranscriptState,
  messageId: string,
  sessionEntryId: string | undefined,
): TranscriptState {
  let changed = false;
  const items = state.items.map((item) => {
    if (item.type !== "message" || item.role !== "user" || item.id !== messageId) return item;
    changed = true;
    const { sessionEntryId: _sessionEntryId, localOnly: _localOnly, ...base } = item;
    return sessionEntryId
      ? { ...base, sessionEntryId }
      : { ...base, localOnly: true };
  });
  return changed ? { items } : state;
}

export function applySessionUpdate(
  state: TranscriptState,
  update: SessionUpdate,
  occurredAtMs?: number,
): TranscriptState {
  const timing = activityTimingFromUpdate(update);
  const boundaryAtMs = occurredAtMs ?? timing?.startedAtMs;
  if (boundaryAtMs !== undefined && closesOpenThought(update)) {
    state = closeOpenThought(state, boundaryAtMs);
  }
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return appendContentChunk(state, "user", update.messageId ?? undefined, update.content);
    case "agent_message_chunk":
      return appendContentChunk(state, agentMessageRole(update.messageId ?? undefined), update.messageId ?? undefined, update.content);
    case "agent_thought_chunk":
      return appendContentChunk(
        state,
        "thought",
        update.messageId ?? undefined,
        update.content,
        timing?.startedAtMs ?? occurredAtMs,
        timing?.endedAtMs,
      );
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
        ...((timing?.startedAtMs ?? occurredAtMs) !== undefined
          ? { startedAtMs: timing?.startedAtMs ?? occurredAtMs }
          : {}),
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
        ...((timing?.endedAtMs ?? (isTerminalToolStatus(update.status) ? occurredAtMs : undefined)) !== undefined
          ? { endedAtMs: timing?.endedAtMs ?? occurredAtMs }
          : {}),
      });
    }
    default:
      return state;
  }
}

export function applySessionUpdates(
  state: TranscriptState,
  updates: readonly SessionUpdate[],
  occurredAtMs?: readonly (number | undefined)[],
): TranscriptState {
  if (updates.length === 0) return state;
  if (state.items.length === 0 && occurredAtMs === undefined) return transcriptFromSessionUpdates(updates);

  const items: TranscriptItem[] = [...state.items];
  const messageIndexes = new Map<string, number>();
  const toolIndexes = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    if (item.type === "message" && item.messageId) {
      messageIndexes.set(`${item.role}\0${item.messageId}`, index);
    } else if (item.type === "tool") {
      toolIndexes.set(item.toolCallId, index);
    }
  }

  for (const [updateIndex, update] of updates.entries()) {
    const timing = activityTimingFromUpdate(update);
    const timestamp = occurredAtMs?.[updateIndex];
    const boundaryAtMs = timestamp ?? timing?.startedAtMs;
    if (boundaryAtMs !== undefined && closesOpenThought(update)) {
      closeOpenThoughtItems(items, boundaryAtMs);
    }
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        appendHistoryContentChunk(items, messageIndexes, "user", update.messageId ?? undefined, update.content);
        break;
      case "agent_message_chunk":
        appendHistoryContentChunk(
          items,
          messageIndexes,
          agentMessageRole(update.messageId ?? undefined),
          update.messageId ?? undefined,
          update.content,
        );
        break;
      case "agent_thought_chunk":
        appendHistoryContentChunk(
          items,
          messageIndexes,
          "thought",
          update.messageId ?? undefined,
          update.content,
          timing?.startedAtMs ?? timestamp,
          timing?.endedAtMs,
        );
        break;
      case "tool_call": {
        const initialContent = toolContent(update.content, `tool:${update.toolCallId}`);
        upsertHistoryTool(items, toolIndexes, update.toolCallId, {
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
          ...((timing?.startedAtMs ?? timestamp) !== undefined
            ? { startedAtMs: timing?.startedAtMs ?? timestamp }
            : {}),
        });
        break;
      }
      case "tool_call_update": {
        const nextContent = update.content != null ? toolContent(update.content, `tool:${update.toolCallId}`) : undefined;
        upsertHistoryTool(items, toolIndexes, update.toolCallId, {
          ...(update.name != null ? { name: update.name } : {}),
          ...(update.title != null ? { title: update.title } : {}),
          ...(update.kind != null ? { kind: update.kind } : {}),
          ...(update.status != null ? { status: update.status } : {}),
          ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
          ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
          ...(nextContent ? { content: nextContent.text, diffs: nextContent.diffs, attachments: nextContent.attachments } : {}),
          ...(update.locations != null ? { path: update.locations[0]?.path } : {}),
          ...((timing?.endedAtMs ?? (isTerminalToolStatus(update.status) ? timestamp : undefined)) !== undefined
            ? { endedAtMs: timing?.endedAtMs ?? timestamp }
            : {}),
        });
        break;
      }
      default:
        break;
    }
  }
  return { items };
}

/** Build persisted history in one pass instead of replaying immutable live updates quadratically. */
export function transcriptFromSessionUpdates(updates: readonly SessionUpdate[]): TranscriptState {
  const items: TranscriptItem[] = [];
  const messageIndexes = new Map<string, number>();
  const toolIndexes = new Map<string, number>();

  for (const update of updates) {
    const timing = activityTimingFromUpdate(update);
    const boundaryAtMs = timing?.startedAtMs;
    if (boundaryAtMs !== undefined && closesOpenThought(update)) {
      closeOpenThoughtItems(items, boundaryAtMs);
    }
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        appendHistoryContentChunk(items, messageIndexes, "user", update.messageId ?? undefined, update.content);
        break;
      case "agent_message_chunk":
        appendHistoryContentChunk(
          items,
          messageIndexes,
          agentMessageRole(update.messageId ?? undefined),
          update.messageId ?? undefined,
          update.content,
        );
        break;
      case "agent_thought_chunk":
        appendHistoryContentChunk(
          items,
          messageIndexes,
          "thought",
          update.messageId ?? undefined,
          update.content,
          timing?.startedAtMs,
          timing?.endedAtMs,
        );
        break;
      case "tool_call": {
        const initialContent = toolContent(update.content, `tool:${update.toolCallId}`);
        upsertHistoryTool(items, toolIndexes, update.toolCallId, {
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
          ...(timing?.startedAtMs !== undefined ? { startedAtMs: timing.startedAtMs } : {}),
        });
        break;
      }
      case "tool_call_update": {
        const nextContent = update.content != null ? toolContent(update.content, `tool:${update.toolCallId}`) : undefined;
        upsertHistoryTool(items, toolIndexes, update.toolCallId, {
          ...(update.name != null ? { name: update.name } : {}),
          ...(update.title != null ? { title: update.title } : {}),
          ...(update.kind != null ? { kind: update.kind } : {}),
          ...(update.status != null ? { status: update.status } : {}),
          ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
          ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
          ...(nextContent ? { content: nextContent.text, diffs: nextContent.diffs, attachments: nextContent.attachments } : {}),
          ...(update.locations != null ? { path: update.locations[0]?.path } : {}),
          ...(timing?.endedAtMs !== undefined && isTerminalToolStatus(update.status)
            ? { endedAtMs: timing.endedAtMs }
            : {}),
        });
        break;
      }
      default:
        break;
    }
  }
  return { items };
}

export function markDeferredToolResults(
  state: TranscriptState,
  toolCallIds: readonly string[],
): TranscriptState {
  if (toolCallIds.length === 0) return state;
  const deferred = new Set(toolCallIds);
  let changed = false;
  const items = state.items.map((item) => {
    if (item.type !== "tool" || !deferred.has(item.toolCallId) || item.deferredResult) return item;
    changed = true;
    return { ...item, deferredResult: true };
  });
  return changed ? { items } : state;
}

export function setToolResultLoading(
  state: TranscriptState,
  toolCallId: string,
  loading: boolean,
  error?: string,
): TranscriptState {
  return patchToolUiState(state, toolCallId, {
    resultLoading: loading,
    resultError: error,
  });
}

export function applyDeferredToolResult(
  state: TranscriptState,
  update: SessionUpdate,
): TranscriptState {
  if (update.sessionUpdate !== "tool_call_update") return state;
  return patchToolUiState(applySessionUpdate(state, update), update.toolCallId, {
    deferredResult: false,
    resultLoading: false,
    resultError: undefined,
  });
}

function appendContentChunk(
  state: TranscriptState,
  role: MessageRole,
  messageId: string | undefined,
  content: ContentBlock,
  startedAtMs?: number,
  endedAtMs?: number,
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
      ...(role === "thought" && endedAtMs !== undefined ? { endedAtMs } : {}),
    };
  } else {
    if (role === "thought" && startedAtMs !== undefined) closeOpenThoughtItems(items, startedAtMs);
    items.push({
      type: "message",
      id,
      ...(messageId ? { messageId } : {}),
      role,
      text: chunk.text,
      attachments: chunk.attachments,
      ...(role === "thought" && startedAtMs !== undefined ? { startedAtMs } : {}),
      ...(role === "thought" && endedAtMs !== undefined ? { endedAtMs } : {}),
    });
  }
  return { items };
}

function agentMessageRole(messageId: string | undefined): Extract<MessageRole, "assistant" | "system"> {
  return messageId?.startsWith("pix-system:") ? "system" : "assistant";
}

function appendHistoryContentChunk(
  items: TranscriptItem[],
  messageIndexes: Map<string, number>,
  role: MessageRole,
  messageId: string | undefined,
  content: ContentBlock,
  startedAtMs?: number,
  endedAtMs?: number,
): void {
  const key = messageId ? `${role}\0${messageId}` : undefined;
  const mappedIndex = key ? messageIndexes.get(key) : undefined;
  const existingIndex = mappedIndex ?? items.length - 1;
  const existing = items[existingIndex];
  const canAppend = existing?.type === "message"
    && existing.role === role
    && (messageId ? existing.messageId === messageId : existing.messageId === undefined);
  const id = messageId ? `${role}:${messageId}` : `${role}:chunk:${items.length}`;
  const attachmentOffset = canAppend ? existing.attachments.length : 0;
  const chunk = messageContent(content, role, id, attachmentOffset);
  if (!chunk.text && chunk.attachments.length === 0) return;

  if (canAppend) {
    items[existingIndex] = {
      ...existing,
      text: existing.text + chunk.text,
      attachments: [...existing.attachments, ...chunk.attachments],
      ...(role === "thought" && endedAtMs !== undefined ? { endedAtMs } : {}),
    };
    return;
  }

  const index = items.length;
  if (role === "thought" && startedAtMs !== undefined) closeOpenThoughtItems(items, startedAtMs);
  items.push({
    type: "message",
    id,
    ...(messageId ? { messageId } : {}),
    role,
    text: chunk.text,
    attachments: chunk.attachments,
    ...(role === "thought" && startedAtMs !== undefined ? { startedAtMs } : {}),
    ...(role === "thought" && endedAtMs !== undefined ? { endedAtMs } : {}),
  });
  if (key) messageIndexes.set(key, index);
}

function upsertTool(
  state: TranscriptState,
  toolCallId: string,
  patch: Partial<Pick<ToolItem, "name" | "title" | "kind" | "status" | "rawInput" | "rawOutput" | "content" | "diffs" | "attachments" | "path" | "deferredResult" | "resultLoading" | "resultError" | "startedAtMs" | "endedAtMs">>,
): TranscriptState {
  const items = [...state.items];
  const index = items.findIndex((item) => item.type === "tool" && item.toolCallId === toolCallId);
  if (index >= 0) {
    const existing = items[index] as ToolItem;
    items[index] = {
      ...existing,
      ...patch,
      ...(existing.startedAtMs !== undefined && patch.startedAtMs !== undefined
        ? { startedAtMs: existing.startedAtMs }
        : {}),
    };
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
      ...(patch.startedAtMs !== undefined ? { startedAtMs: patch.startedAtMs } : {}),
      ...(patch.endedAtMs !== undefined ? { endedAtMs: patch.endedAtMs } : {}),
    });
  }
  return { items };
}

function upsertHistoryTool(
  items: TranscriptItem[],
  toolIndexes: Map<string, number>,
  toolCallId: string,
  patch: Partial<Pick<ToolItem, "name" | "title" | "kind" | "status" | "rawInput" | "rawOutput" | "content" | "diffs" | "attachments" | "path" | "startedAtMs" | "endedAtMs">>,
): void {
  const index = toolIndexes.get(toolCallId);
  if (index !== undefined) {
    const existing = items[index] as ToolItem;
    items[index] = {
      ...existing,
      ...patch,
      ...(existing.startedAtMs !== undefined && patch.startedAtMs !== undefined
        ? { startedAtMs: existing.startedAtMs }
        : {}),
    };
    return;
  }
  toolIndexes.set(toolCallId, items.length);
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
    ...(patch.startedAtMs !== undefined ? { startedAtMs: patch.startedAtMs } : {}),
    ...(patch.endedAtMs !== undefined ? { endedAtMs: patch.endedAtMs } : {}),
  });
}

function patchToolUiState(
  state: TranscriptState,
  toolCallId: string,
  patch: Pick<Partial<ToolItem>, "deferredResult" | "resultLoading" | "resultError">,
): TranscriptState {
  const index = state.items.findIndex((item) => item.type === "tool" && item.toolCallId === toolCallId);
  if (index < 0) return state;
  const items = [...state.items];
  items[index] = { ...(items[index] as ToolItem), ...patch };
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
  let earliestStart: number | undefined;
  let latestEnd: number | undefined;
  for (const tool of tools) {
    if (tool.startedAtMs !== undefined) {
      earliestStart = earliestStart === undefined ? tool.startedAtMs : Math.min(earliestStart, tool.startedAtMs);
    }
    if (tool.endedAtMs !== undefined) {
      latestEnd = latestEnd === undefined ? tool.endedAtMs : Math.max(latestEnd, tool.endedAtMs);
    }
  }
  const durationMs = !active && earliestStart !== undefined && latestEnd !== undefined
    ? Math.max(0, latestEnd - earliestStart)
    : undefined;

  return {
    type: "tool-group",
    id: `tool-group:${tools[0].toolCallId}`,
    tools,
    status,
    active,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export function finalizeTranscriptActivity(state: TranscriptState, endedAtMs: number): TranscriptState {
  return closeOpenThought(state, endedAtMs);
}

export function formatTranscriptDuration(durationMs: number): string {
  const milliseconds = Math.max(0, durationMs);
  if (milliseconds < 100) return "<0.1s";
  if (milliseconds < 10_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1000)}s`;
  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function closesOpenThought(update: SessionUpdate): boolean {
  return update.sessionUpdate === "user_message_chunk"
    || update.sessionUpdate === "agent_message_chunk"
    || update.sessionUpdate === "tool_call";
}

function closeOpenThought(state: TranscriptState, endedAtMs: number): TranscriptState {
  const items = [...state.items];
  return closeOpenThoughtItems(items, endedAtMs) ? { items } : state;
}

function closeOpenThoughtItems(items: TranscriptItem[], endedAtMs: number): boolean {
  const index = items.length - 1;
  const item = items[index];
  if (item?.type !== "message" || item.role !== "thought") return false;
  if (item.startedAtMs === undefined || item.endedAtMs !== undefined) return false;
  items[index] = { ...item, endedAtMs: Math.max(item.startedAtMs, endedAtMs) };
  return true;
}

function isTerminalToolStatus(status: ToolCallStatus | null | undefined): boolean {
  return status === "completed" || status === "failed";
}

function activityTimingFromUpdate(update: SessionUpdate): ActivityTimingMeta | undefined {
  const meta = update._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const value = meta[PIX_ACTIVITY_TIMING_META_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const startedAtMs = finiteActivityTimestamp(record.startedAtMs);
  const endedAtMs = finiteActivityTimestamp(record.endedAtMs);
  if (startedAtMs === undefined && endedAtMs === undefined) return undefined;
  return {
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    ...(endedAtMs !== undefined ? { endedAtMs } : {}),
  };
}

function finiteActivityTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
      if (content.uri.startsWith("pix-deferred-image:")) {
        const encoded = content.uri.slice("pix-deferred-image:".length);
        let imageId: string;
        try {
          imageId = decodeURIComponent(encoded);
        } catch {
          imageId = encoded;
        }
        return {
          text: "",
          attachments: [attachmentFromDeferredImage(
            imageId,
            content.mimeType ?? "image/png",
            `${idPrefix}:attachment:${attachmentOffset}`,
            content.name ?? undefined,
          )],
        };
      }
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
