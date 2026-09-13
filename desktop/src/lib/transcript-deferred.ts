import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { applySessionUpdate } from "./transcript-reducer";
import type { ToolItem, TranscriptState } from "./transcript-types";

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
