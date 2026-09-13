import type { DcpConfig } from "./config.js";
import type { DcpNudgeAnchor, DcpState } from "./state.js";
import type {
  CompressionCandidate,
  DcpNudgeType,
  MessageCompressionCandidate,
  NudgeThresholds,
} from "./pruner-types.js";
import { messageText } from "./pruner-metadata.js";
import { stableMessageKeys } from "./pruner-message-ids.js";

function coercePercentThreshold(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value !== "string") return fallback;

  const trimmed = value.trim();
  if (!trimmed) return fallback;
  const parsed = Number.parseFloat(trimmed.endsWith("%") ? trimmed.slice(0, -1) : trimmed);
  if (!Number.isFinite(parsed)) return fallback;
  if (trimmed.endsWith("%")) return parsed / 100;
  return parsed <= 1 ? parsed : fallback;
}

function nudgeTypeLabel(type: DcpNudgeType): string {
  switch (type) {
    case "context-strong": return "context limit (strong)";
    case "context-soft": return "context limit";
    case "iteration": return "iteration";
    case "turn": return "turn";
  }
}

function isRealAnchorCandidate(msg: any): boolean {
  const role = msg?.role ?? "";
  if (role !== "user" && role !== "toolResult") return false;
  return msg?._dcpOrigin !== "block" && msg?._dcpOrigin !== "dcp-control";
}

function findAnchorMessage(messages: any[], freshToolResultIds?: ReadonlySet<string>): { msg: any; index: number; stableId: string; timestamp: number; role: string } | null {
  const stableKeys = stableMessageKeys(messages);
  // Only append to a fresh tail; never edit an earlier user/assistant prefix.
  // Tool-result freshness requires a positive local lifecycle grant, not the
  // absence of successful provider evidence (which is unknown after restart).
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?._dcpOrigin === "dcp-control") continue;
    if (!isRealAnchorCandidate(msg) || !Number.isFinite(msg.timestamp)) return null;
    if (msg.role === "toolResult") {
      if (!freshToolResultIds?.has(msg.toolCallId)) return null;
      // A duplicate/reused call ID is not an unambiguous fresh carrier.
      if (messages.filter((item) => item?.role === "toolResult" && item.toolCallId === msg.toolCallId).length !== 1) return null;
    }
    return { msg, index: i, stableId: stableKeys[i]!, timestamp: msg.timestamp, role: msg.role };
  }

  return null;
}

export function hasCacheSafeNudgeCarrier(
  messages: any[],
  freshToolResultIds?: ReadonlySet<string>,
  anchors: readonly DcpNudgeAnchor[] = [],
): boolean {
  if (findAnchorMessage(messages, freshToolResultIds) !== null) return true;
  // A previously published reminder remains deliverable without editing its
  // carrier. Losing the grant to create a NEW reminder on a provider attempt
  // must not make retries bypass the completed-opportunity patience policy.
  const stableKeys = stableMessageKeys(messages);
  return anchors.some((anchor) => typeof anchor.renderedReminder === "string" &&
    anchor.renderedReminder.length > 0 &&
    messages.some((message, index) => anchorMatchesMessage(anchor, message, stableKeys[index]!)));
}

function anchorMatchesMessage(anchor: DcpNudgeAnchor, msg: any, stableKey: string): boolean {
  if (!isRealAnchorCandidate(msg) || msg.role !== anchor.anchorRole) return false;
  if (anchor.anchorStableId) return stableKey === anchor.anchorStableId;
  // Legacy user anchors may be timestamp-only. Tool anchors must never rebind
  // to another parallel result that happens to share their timestamp.
  if (msg.role === "toolResult") return false;
  return msg?.timestamp === anchor.anchorTimestamp;
}

function isNewerAnchor(candidate: DcpNudgeAnchor, current: DcpNudgeAnchor): boolean {
  if (candidate.updatedAt !== current.updatedAt) return candidate.updatedAt > current.updatedAt;
  if (candidate.createdAt !== current.createdAt) return candidate.createdAt > current.createdAt;
  return candidate.id > current.id;
}

function appendTextToMessage(msg: any, text: string): void {
  const suffix = `\n\n${text}`;
  if (typeof msg.content === "string") {
    msg.content += suffix;
    return;
  }

  if (!Array.isArray(msg.content)) {
    msg.content = [{ type: "text", text }];
    return;
  }

  // Only user/tool-result carriers reach here. Assistant items are immutable.
  msg.content = [...msg.content, { type: "text", text: suffix }];
}

function insertBeforeReminderClose(reminder: string, detail: string): string {
  if (!detail.trim()) return reminder;
  const close = "</dcp-system-reminder>";
  const idx = reminder.toLowerCase().lastIndexOf(close.toLowerCase());
  if (idx === -1) return `${reminder}\n\n${detail}`;
  return `${reminder.slice(0, idx).trimEnd()}\n\n${detail}\n${reminder.slice(idx)}`;
}

function formatActiveBlocks(state: DcpState): string {
  const blocks = state.compressionBlocks
    .filter((block) => block.active)
    .sort((a, b) => a.id - b.id)
    .slice(0, 12)
    .map((block) => {
      const topic = block.topic.replace(/\s+/g, " ").trim();
      const label = topic.length > 42 ? `${topic.slice(0, 41)}…` : topic;
      return `b${block.id}${label ? ` "${label.replace(/"/g, "'")}"` : ""}`;
    });
  if (blocks.length === 0) return "";
  return `Active compressed blocks: ${blocks.join(", ")}. If your selected range includes one, include the required \`(bN)\` placeholder exactly once.`;
}

function formatCandidateActions(
  candidate: CompressionCandidate | null,
  messageCandidates: MessageCompressionCandidate[],
  state: DcpState,
): string {
  const parts: string[] = [];

  if (candidate) {
    parts.push(
      `Recommended range candidate: ${candidate.startId}..${candidate.endId} (${candidate.messageCount} messages, ~${candidate.estimatedTokens} tokens, ${candidate.reason}). Compress this before the next search/read/test/web lookup if it is closed.`,
    );
    if (candidate.includedBlockIds.length > 0) {
      parts.push(
        `This range includes existing block(s): ${candidate.includedBlockIds.map((id) => `b${id}`).join(", ")}. Preserve each required \`(bN)\` placeholder exactly once in the summary.`,
      );
    }
  }

  const highPriority = messageCandidates.filter((item) => item.priority === "high");
  const listedMessages = (highPriority.length > 0 ? highPriority : messageCandidates).slice(0, 8);
  if (listedMessages.length > 0) {
    parts.push(
      `Recommended message candidates: ${listedMessages
        .map((item) => `${item.messageId} (${item.priority}, ${item.role}, ~${item.estimatedTokens} tokens)`)
        .join(", ")}. High-priority stale messages MUST be compressed once their full text is no longer needed; passing logs should become command + pass/fail + follow-up status only. Batch multiple messages in one compress call when possible.`,
    );
  }

  const activeBlocks = formatActiveBlocks(state);
  if (activeBlocks) parts.push(activeBlocks);

  if (parts.length === 0) {
    parts.push("No automatic candidate is certain; scan the older closed context now and compress any completed research, implementation, config/doc edit, verification, CI-log inspection, or dead-end debugging slice before accumulating more tool output.");
  }

  return [`CONCRETE NEXT ACTION`, ...parts].join("\n");
}

export function appendConcreteNudgeGuidance(
  reminder: string,
  candidate: CompressionCandidate | null,
  messageCandidates: MessageCompressionCandidate[],
  state: DcpState,
): string {
  return insertBeforeReminderClose(
    reminder,
    formatCandidateActions(candidate, messageCandidates, state),
  );
}

export function upsertNudgeAnchor(
  messages: any[],
  state: DcpState,
  type: DcpNudgeType,
  options: { contextPercent?: number; renderedReminder?: string; freshToolResultIds?: ReadonlySet<string> } = {},
): { anchor: DcpNudgeAnchor | null; created: boolean; updated: boolean } {
  const stableKeys = stableMessageKeys(messages);
  let existing: DcpNudgeAnchor | null = null;
  for (const anchor of state.nudgeAnchors) {
    const stillPresent = messages.some((message, index) =>
      isRealAnchorCandidate(message) && anchorMatchesMessage(anchor, message, stableKeys[index]!),
    );
    if (!stillPresent) continue;
    if (!existing || isNewerAnchor(anchor, existing)) existing = anchor;
  }

  if (existing) {
    // Once published, both carrier and bytes are immutable. A later urgency
    // increase must not rewrite an old provider prefix.
    state.nudgeAnchors = [existing];
    return { anchor: existing, created: false, updated: false };
  }

  if (state.nudgeAnchors.length > 0) {
    state.nudgeAnchors = [];
    state.lastNudge = undefined;
  }

  const target = findAnchorMessage(messages, options.freshToolResultIds);
  if (!target) {
    // No positively fresh carrier: do not synthesize a disappearing tail or
    // reinterpret unknown historical exposure as permission to edit history.
    return { anchor: null, created: false, updated: false };
  }

  const now = Date.now();
  const anchor: DcpNudgeAnchor = {
    id: state.nextNudgeAnchorId++,
    type,
    anchorTimestamp: target.timestamp,
    anchorStableId: target.stableId,
    anchorRole: target.role,
    turnIndex: state.currentTurn,
    contextPercent: options.contextPercent,
    renderedReminder: options.renderedReminder,
    createdAt: now,
    updatedAt: now,
  };
  // A nudge follows the latest useful message. Replacing the previous anchor
  // prevents one full reminder from accumulating per turn/assistant response.
  state.nudgeAnchors = [anchor];
  state.lastNudge = {
    type,
    anchorId: anchor.id,
    anchorTimestamp: anchor.anchorTimestamp,
    anchorStableId: anchor.anchorStableId,
    contextPercent: anchor.contextPercent,
    createdAt: now,
  };
  return { anchor, created: true, updated: true };
}

export function applyAnchoredNudges(
  messages: any[],
  state: DcpState,
  render: (anchor: DcpNudgeAnchor) => string,
): { rendered: boolean; stateChanged: boolean } {
  if (state.nudgeAnchors.length === 0) return { rendered: false, stateChanged: false };

  const stableKeys = stableMessageKeys(messages);
  const priorAnchors = state.nudgeAnchors;
  let selected: { anchor: DcpNudgeAnchor; index: number } | null = null;
  for (const anchor of state.nudgeAnchors) {
    const index = messages.findIndex((msg, messageIndex) =>
      anchorMatchesMessage(anchor, msg, stableKeys[messageIndex]!),
    );
    if (index === -1) continue;
    if (!selected || isNewerAnchor(anchor, selected.anchor)) {
      selected = { anchor, index };
    }
  }

  // Render only the newest valid anchor and discard stale predecessors.
  state.nudgeAnchors = selected ? [selected.anchor] : [];
  const anchorSetChanged = state.nudgeAnchors.length !== priorAnchors.length ||
    state.nudgeAnchors.some((anchor, index) => anchor !== priorAnchors[index]);
  if (!selected) return { rendered: false, stateChanged: anchorSetChanged };

  const materializedReminder = selected.anchor.renderedReminder === undefined;
  const reminder = selected.anchor.renderedReminder ?? render(selected.anchor);
  if (materializedReminder) selected.anchor.renderedReminder = reminder;
  const anchorMessage = messages[selected.index];
  if (!isRealAnchorCandidate(anchorMessage)) {
    state.nudgeAnchors = [];
    state.lastNudge = undefined;
    return { rendered: false, stateChanged: true };
  }
  appendTextToMessage(anchorMessage, reminder);
  return {
    rendered: true,
    stateChanged: anchorSetChanged || materializedReminder,
  };
}

export function clearDcpNudgeAnchors(state: DcpState): number {
  const cleared = state.nudgeAnchors.length;
  state.nudgeAnchors = [];
  state.nudgeCounter = 0;
  state.lastNudge = undefined;
  return cleared;
}

export { nudgeTypeLabel };

export function getNudgeType(
  contextPercent: number,
  state: DcpState,
  config: DcpConfig,
  toolCallsSinceLastUser: number,
  thresholds: NudgeThresholds = {},
): DcpNudgeType | null {
  const { nudgeFrequency, nudgeForce, iterationNudgeThreshold } =
    config.compress;
  const minContextPercent = coercePercentThreshold(
    thresholds.minContextPercent ?? config.compress.minContextPercent,
    0.25,
  );
  const maxContextPercent = coercePercentThreshold(
    thresholds.maxContextPercent ?? config.compress.maxContextPercent,
    0.65,
  );
  const cadence = Math.max(1, Math.floor(nudgeFrequency));

  if (!Number.isFinite(contextPercent)) return null;
  if (contextPercent > maxContextPercent) {
    return nudgeForce === "strong" ? "context-strong" : "context-soft";
  }

  if (contextPercent <= minContextPercent) return null;
  if (state.nudgeCounter + 1 < cadence) return null;

  if (toolCallsSinceLastUser >= iterationNudgeThreshold) {
    return "iteration";
  }

  return "turn";
}
