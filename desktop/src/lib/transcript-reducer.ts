import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk";
import { agentMessageRole, messageContent, toolContent } from "./transcript-content";
import {
  activityTimingFromUpdate,
  closeOpenThought,
  closeOpenThoughtItems,
  closesOpenThought,
  isTerminalToolStatus,
} from "./transcript-timing";
import type { MessageRole, ToolItem, TranscriptItem, TranscriptState } from "./transcript-types";
import { skillReadName } from "./tool-presentation";

interface ReducerIndexes {
  readonly messages: Map<string, number>;
  readonly tools: Map<string, number>;
}

type ToolPatch = Partial<Pick<
  ToolItem,
  | "name"
  | "title"
  | "kind"
  | "status"
  | "rawInput"
  | "skillName"
  | "rawOutput"
  | "content"
  | "diffs"
  | "attachments"
  | "path"
  | "startedAtMs"
  | "endedAtMs"
>>;

export function applySessionUpdate(
  state: TranscriptState,
  update: SessionUpdate,
  occurredAtMs?: number,
): TranscriptState {
  const timing = activityTimingFromUpdate(update);
  const boundaryAtMs = occurredAtMs ?? timing?.startedAtMs;
  let baseState = state;
  if (boundaryAtMs !== undefined && closesOpenThought(update)) {
    baseState = closeOpenThought(baseState, boundaryAtMs);
  }
  const items = [...baseState.items];
  return applyUpdateToItems(items, update, occurredAtMs, undefined, false)
    ? { items }
    : baseState;
}

export function applySessionUpdates(
  state: TranscriptState,
  updates: readonly SessionUpdate[],
  occurredAtMs?: readonly (number | undefined)[],
): TranscriptState {
  if (updates.length === 0) return state;
  if (state.items.length === 0 && occurredAtMs === undefined) return transcriptFromSessionUpdates(updates);

  const items: TranscriptItem[] = [...state.items];
  const indexes = buildIndexes(items);
  for (const [updateIndex, update] of updates.entries()) {
    applyUpdateToItems(items, update, occurredAtMs?.[updateIndex], indexes, false);
  }
  return { items };
}

/** Build persisted history in one pass instead of replaying immutable live updates quadratically. */
export function transcriptFromSessionUpdates(updates: readonly SessionUpdate[]): TranscriptState {
  const items: TranscriptItem[] = [];
  const indexes = buildIndexes(items);
  for (const update of updates) applyUpdateToItems(items, update, undefined, indexes, true);
  return { items };
}

function buildIndexes(items: readonly TranscriptItem[]): ReducerIndexes {
  const messages = new Map<string, number>();
  const tools = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    if (item.type === "message" && item.messageId) {
      messages.set(messageKey(item.role, item.messageId), index);
    } else if (item.type === "tool") {
      tools.set(item.toolCallId, index);
    }
  }
  return { messages, tools };
}

function applyUpdateToItems(
  items: TranscriptItem[],
  update: SessionUpdate,
  occurredAtMs: number | undefined,
  indexes: ReducerIndexes | undefined,
  replay: boolean,
): boolean {
  const timing = activityTimingFromUpdate(update);
  const boundaryAtMs = occurredAtMs ?? timing?.startedAtMs;
  let changed = false;
  if (boundaryAtMs !== undefined && closesOpenThought(update)) {
    changed = closeOpenThoughtItems(items, boundaryAtMs) || changed;
  }

  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return appendMessageChunk(items, indexes?.messages, "user", update.messageId ?? undefined, update.content) || changed;
    case "agent_message_chunk":
      return appendMessageChunk(
        items,
        indexes?.messages,
        agentMessageRole(update.messageId ?? undefined),
        update.messageId ?? undefined,
        update.content,
      ) || changed;
    case "agent_thought_chunk":
      return appendMessageChunk(
        items,
        indexes?.messages,
        "thought",
        update.messageId ?? undefined,
        update.content,
        timing?.startedAtMs ?? occurredAtMs,
        timing?.endedAtMs,
      ) || changed;
    case "tool_call": {
      const initialContent = toolContent(update.content, `tool:${update.toolCallId}`);
      upsertTool(items, indexes?.tools, update.toolCallId, {
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
      return true;
    }
    case "tool_call_update": {
      const nextContent = update.content != null ? toolContent(update.content, `tool:${update.toolCallId}`) : undefined;
      const endedAtMs = replay
        ? (isTerminalToolStatus(update.status) ? timing?.endedAtMs : undefined)
        : timing?.endedAtMs ?? (isTerminalToolStatus(update.status) ? occurredAtMs : undefined);
      upsertTool(items, indexes?.tools, update.toolCallId, {
        ...(update.name != null ? { name: update.name } : {}),
        ...(update.title != null ? { title: update.title } : {}),
        ...(update.kind != null ? { kind: update.kind } : {}),
        ...(update.status != null ? { status: update.status } : {}),
        ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
        ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
        ...(nextContent ? { content: nextContent.text, diffs: nextContent.diffs, attachments: nextContent.attachments } : {}),
        ...(update.locations != null ? { path: update.locations[0]?.path } : {}),
        ...(endedAtMs !== undefined ? { endedAtMs } : {}),
      });
      return true;
    }
    default:
      return changed;
  }
}

function appendMessageChunk(
  items: TranscriptItem[],
  messageIndexes: Map<string, number> | undefined,
  role: MessageRole,
  messageId: string | undefined,
  content: ContentBlock,
  startedAtMs?: number,
  endedAtMs?: number,
): boolean {
  const key = messageId ? messageKey(role, messageId) : undefined;
  const existingIndex = messageIndexes
    ? (key ? messageIndexes.get(key) : undefined) ?? items.length - 1
    : messageId
      ? items.findIndex((item) => item.type === "message" && item.role === role && item.messageId === messageId)
      : items.length - 1;
  const existing = items[existingIndex];
  const canAppend = existing?.type === "message"
    && existing.role === role
    && (messageId ? existing.messageId === messageId : existing.messageId === undefined);
  const id = messageId ? `${role}:${messageId}` : `${role}:chunk:${items.length}`;
  const attachmentOffset = canAppend ? existing.attachments.length : 0;
  const chunk = messageContent(content, role, id, attachmentOffset);
  if (!chunk.text && chunk.attachments.length === 0) return false;

  if (canAppend) {
    items[existingIndex] = {
      ...existing,
      text: existing.text + chunk.text,
      attachments: [...existing.attachments, ...chunk.attachments],
      ...(role === "thought" && endedAtMs !== undefined ? { endedAtMs } : {}),
    };
    return true;
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
  if (key && messageIndexes) messageIndexes.set(key, index);
  return true;
}

function upsertTool(
  items: TranscriptItem[],
  toolIndexes: Map<string, number> | undefined,
  toolCallId: string,
  patch: ToolPatch,
): void {
  const index = toolIndexes?.get(toolCallId)
    ?? (toolIndexes ? -1 : items.findIndex((item) => item.type === "tool" && item.toolCallId === toolCallId));
  if (index >= 0) {
    const existing = items[index] as ToolItem;
    const skillName = patch.rawInput !== undefined || patch.name !== undefined || patch.kind !== undefined
      || patch.title !== undefined || patch.path !== undefined
      ? skillReadName(skillToolName(patch.name ?? existing.name, patch.kind ?? existing.kind, patch.title ?? existing.title),
        patch.rawInput ?? existing.rawInput, patch.path ?? existing.path, patch.title ?? existing.title)
      : existing.skillName;
    items[index] = {
      ...existing,
      ...patch,
      skillName,
      ...(existing.startedAtMs !== undefined && patch.startedAtMs !== undefined
        ? { startedAtMs: existing.startedAtMs }
        : {}),
    };
    return;
  }

  if (toolIndexes) toolIndexes.set(toolCallId, items.length);
  const skillName = skillReadName(skillToolName(patch.name, patch.kind, patch.title), patch.rawInput, patch.path, patch.title);
  items.push({
    type: "tool",
    id: `tool:${toolCallId}`,
    toolCallId,
    ...(patch.name ? { name: patch.name } : {}),
    title: patch.title ?? "Tool call",
    kind: patch.kind ?? "other",
    status: patch.status ?? "pending",
    ...(patch.rawInput !== undefined ? { rawInput: patch.rawInput } : {}),
    ...(skillName ? { skillName } : {}),
    ...(patch.rawOutput !== undefined ? { rawOutput: patch.rawOutput } : {}),
    content: patch.content ?? "",
    diffs: patch.diffs ?? [],
    attachments: patch.attachments ?? [],
    ...(patch.path ? { path: patch.path } : {}),
    ...(patch.startedAtMs !== undefined ? { startedAtMs: patch.startedAtMs } : {}),
    ...(patch.endedAtMs !== undefined ? { endedAtMs: patch.endedAtMs } : {}),
  });
}

function skillToolName(name?: string, kind?: string, title?: string): string | undefined {
  return name ?? (kind && kind !== "other" ? kind : title?.match(/^([^\s:]+)/u)?.[1]);
}

function messageKey(role: MessageRole, messageId: string): string {
  return `${role}\0${messageId}`;
}
