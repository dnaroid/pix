import type { SessionUpdate, ToolCallStatus } from "@agentclientprotocol/sdk";
import type { TranscriptItem, TranscriptState } from "./transcript-types";

const PIX_ACTIVITY_TIMING_META_KEY = "pix.activityTiming";

export interface ActivityTimingMeta {
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
}

export function finalizeTranscriptActivity(state: TranscriptState, endedAtMs: number): TranscriptState {
  return closeOpenThought(state, endedAtMs);
}

export function closesOpenThought(update: SessionUpdate): boolean {
  return update.sessionUpdate === "user_message_chunk"
    || update.sessionUpdate === "agent_message_chunk"
    || update.sessionUpdate === "tool_call";
}

export function closeOpenThought(state: TranscriptState, endedAtMs: number): TranscriptState {
  const items = [...state.items];
  return closeOpenThoughtItems(items, endedAtMs) ? { items } : state;
}

export function closeOpenThoughtItems(items: TranscriptItem[], endedAtMs: number): boolean {
  const index = items.length - 1;
  const item = items[index];
  if (item?.type !== "message" || item.role !== "thought") return false;
  if (item.startedAtMs === undefined || item.endedAtMs !== undefined) return false;
  items[index] = { ...item, endedAtMs: Math.max(item.startedAtMs, endedAtMs) };
  return true;
}

export function isTerminalToolStatus(status: ToolCallStatus | null | undefined): boolean {
  return status === "completed" || status === "failed";
}

export function activityTimingFromUpdate(update: SessionUpdate): ActivityTimingMeta | undefined {
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
