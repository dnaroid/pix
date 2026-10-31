import type { ToolItem, TranscriptItem, TranscriptState } from "./transcript-types";

/** Merge snapshots, not chunks: recovered tools can already exist in both. */
export function mergeTranscriptHistory(history: TranscriptState, current: TranscriptState): TranscriptState {
  const items: TranscriptItem[] = [];
  const indexes = new Map<string, number>();
  for (const item of [...history.items, ...current.items]) {
    const index = indexes.get(item.id);
    const previous = index === undefined ? undefined : items[index];
    if (index === undefined || !previous) {
      indexes.set(item.id, items.length);
      items.push(item);
      continue;
    }
    if (previous.type === "tool" && item.type === "tool") {
      items[index] = mergeTool(previous, item);
    } else if (previous.type === "message" && item.type === "message") {
      // Replay message IDs differ from live-stream IDs. Equal IDs identify
      // overlapping cached snapshots, whose text must not be appended again.
      items[index] = item.text.length >= previous.text.length ? item : previous;
    }
  }
  return { items };
}

function terminal(tool: ToolItem): boolean {
  return tool.status === "completed" || tool.status === "failed";
}

function mergeTool(history: ToolItem, current: ToolItem): ToolItem {
  // A cached start notification must not revive a result already in history.
  const [older, newer] = terminal(history) && !terminal(current)
    ? [current, history] : [history, current];
  const hasResult = terminal(newer) && (newer.content !== "" || newer.rawOutput !== undefined
    || newer.attachments.length > 0 || newer.diffs.length > 0 || newer.deferredResult === false);
  return {
    ...older,
    ...newer,
    name: newer.name ?? older.name,
    title: newer.title === "Tool call" ? older.title : newer.title,
    kind: newer.kind === "other" ? older.kind : newer.kind,
    skillName: newer.skillName ?? older.skillName,
    activityAction: newer.activityAction ?? older.activityAction,
    imageRead: newer.imageRead || older.imageRead,
    content: newer.content || older.content,
    attachments: newer.attachments.length ? newer.attachments : older.attachments,
    diffs: newer.diffs.length ? newer.diffs : older.diffs,
    startedAtMs: history.startedAtMs ?? current.startedAtMs,
    deferredResult: hasResult ? false : newer.deferredResult ?? older.deferredResult,
  };
}

/**
 * Replace a cache that was filled only by live updates (never hydrated).
 * Live stream message IDs differ from replay IDs, so merging would duplicate
 * any turn that is already persisted. History supersedes the items cached
 * before the history request started; items added or changed afterwards and
 * unpersisted live notices stay on top.
 */
export function supersedeLiveTranscript(
  history: TranscriptState,
  current: TranscriptState,
  cachedAtRequest: readonly TranscriptItem[],
): TranscriptState {
  const persisted = new Set(cachedAtRequest);
  const kept = current.items.filter((item) => !persisted.has(item) || unpersistedNotice(item));
  return mergeTranscriptHistory(history, { items: kept });
}

function unpersistedNotice(item: TranscriptItem): boolean {
  return item.type === "message"
    && item.role === "system"
    && !item.messageId?.startsWith("pix-system:error:");
}
