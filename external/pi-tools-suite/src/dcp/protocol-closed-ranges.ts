import { closeConversationRange, detectToolGroupSpans } from "./conversation-index.js";
import type { ConversationIndexEntry } from "./state.js";

interface RangeBoundary {
  id: string;
  messageIndex: number;
}

function diagnosticId(id: string): string {
  return id.length > 160 ? `${id.slice(0, 157)}...` : id;
}

/**
 * Maximal closed runs inside an already policy-filtered selection. Incomplete
 * groups are barriers, not reasons to discard all later completed work. Never
 * widen across a retention boundary or an excluded message/block to close one.
 */
export function protocolClosedBoundaryRuns<T extends RangeBoundary>(
  boundaries: T[],
  entries: ConversationIndexEntry[],
): T[][] {
  if (boundaries.length === 0 || entries.length === 0) return [];
  const first = boundaries[0]!.messageIndex;
  const last = boundaries[boundaries.length - 1]!.messageIndex;
  const included = new Set(boundaries.map((boundary) => boundary.messageIndex));
  const excluded = new Set(entries.filter((entry) =>
    entry.index >= first && entry.index <= last && !included.has(entry.index) &&
    !entry.passthrough && entry.origin !== "dcp-control",
  ).map((entry) => entry.index));
  const barriers = [...excluded].map((index) => ({ startIndex: index, endIndex: index }));
  for (const group of detectToolGroupSpans(entries)) {
    if (group.endIndex < first || group.startIndex > last) continue;
    if (!group.complete || group.startIndex < first || group.endIndex > last ||
      entries.slice(group.startIndex, group.endIndex + 1).some((entry) => excluded.has(entry.index))) {
      barriers.push(group);
    }
  }
  barriers.sort((a, b) => a.startIndex - b.startIndex);

  const runs: T[][] = [];
  let cursor = 0;
  for (const barrier of barriers) {
    const start = cursor;
    while (cursor < boundaries.length && boundaries[cursor]!.messageIndex < barrier.startIndex) cursor++;
    if (cursor > start) runs.push(boundaries.slice(start, cursor));
    while (cursor < boundaries.length && boundaries[cursor]!.messageIndex <= barrier.endIndex) cursor++;
  }
  if (cursor < boundaries.length) runs.push(boundaries.slice(cursor));

  // Use the executor's closure authority, including non-addressable entries.
  return runs.filter((run) => {
    const closure = closeConversationRange(entries, run[0]!.id, run[run.length - 1]!.id);
    return closure && !closure.expanded && !closure.incompleteToolGroup;
  });
}

/** Bounded recovery guidance for stale/manual selections; never changes them. */
export function incompleteToolGroupGuidance(
  entries: ConversationIndexEntry[],
  startId: string,
  endId: string,
): string {
  const closure = closeConversationRange(entries, startId, endId);
  if (!closure) return "Choose another protocol-closed range.";
  const blockers = detectToolGroupSpans(entries).filter((group) =>
    !group.complete && group.startIndex <= closure.endIndex && group.endIndex >= closure.startIndex,
  );
  const details = blockers.slice(0, 3).map((group) => {
    const assistant = entries[group.startIndex]!;
    const results = new Set(entries.slice(group.startIndex + 1, group.endIndex + 1)
      .filter((entry) => entry.role === "toolResult" || entry.role === "bashExecution")
      .map((entry) => entry.toolCallId));
    const missing = group.toolCallIds.filter((id) => !results.has(id));
    return `${diagnosticId(assistant.visibleId ?? assistant.stableId)} (missing tool result: ${missing.slice(0, 3).map(diagnosticId).join(", ")}${missing.length > 3 ? ", …" : ""})`;
  });
  const boundaries = entries.flatMap((entry) => {
    if (entry.index < closure.requestedStartIndex || entry.index > closure.requestedEndIndex ||
      entry.passthrough || entry.origin === "dcp-control") return [];
    const id = entry.blockId !== undefined ? `b${entry.blockId}` : entry.visibleId;
    return id ? [{ id, messageIndex: entry.index }] : [];
  });
  const alternatives = protocolClosedBoundaryRuns(boundaries, entries);
  const hints = alternatives.slice(0, 3).map((run) => `${run[0]!.id}..${run[run.length - 1]!.id}`);
  return `Blocking group(s): ${details.join("; ")}${blockers.length > 3 ? "; …" : ""}. ` +
    (hints.length > 0
      ? `Protocol-safe alternatives inside this selection: ${hints.join(", ")}${alternatives.length > 3 ? ", …" : ""}. `
      : "No protocol-closed subrange is available inside this selection. ") +
    "Choose a closed range or message-mode candidates outside the blocked groups. " +
    "Changing only an endId beyond a blocked group will not help; wait only if its tool is actually still running.";
}
