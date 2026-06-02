import type { DcpConfig } from "./config.js";
import type { DcpNudgeAnchor, DcpState } from "./state.js";
import type {
  CompressionCandidate,
  DcpNudgeType,
  MessageCompressionCandidate,
  NudgeThresholds,
} from "./pruner-types.js";
import { extractBlockId, messageText } from "./pruner-metadata.js";
import { stableMessageId } from "./pruner-message-ids.js";

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

export function injectNudge(messages: any[], nudgeText: string): void {
  messages.push({
    role: "user",
    content: nudgeText,
    timestamp: Date.now(),
  });
}

function typePriority(type: DcpNudgeType): number {
  switch (type) {
    case "context-strong": return 4;
    case "context-soft": return 3;
    case "iteration": return 2;
    case "turn": return 1;
  }
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
  if (role !== "user" && role !== "assistant") return false;
  const text = messageText(msg);
  if (text.includes("<dcp-system-reminder>")) return false;
  if (extractBlockId(text) !== undefined) return false;
  return true;
}

function findAnchorMessage(messages: any[]): { msg: any; index: number; stableId: string; timestamp: number; role: string } | null {
  // Prefer the latest real user message: it gives the reminder direct user-like
  // salience without creating a new synthetic message at the end of context.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user" || !isRealAnchorCandidate(msg)) continue;
    if (!Number.isFinite(msg.timestamp)) continue;
    return {
      msg,
      index: i,
      stableId: stableMessageId(msg, i),
      timestamp: msg.timestamp,
      role: msg.role,
    };
  }

  // Fallback to assistant messages if no raw user message is present.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant" || !isRealAnchorCandidate(msg)) continue;
    if (!Number.isFinite(msg.timestamp)) continue;
    return {
      msg,
      index: i,
      stableId: stableMessageId(msg, i),
      timestamp: msg.timestamp,
      role: msg.role,
    };
  }

  return null;
}

function anchorMatchesMessage(anchor: DcpNudgeAnchor, msg: any, index: number): boolean {
  if (anchor.anchorStableId && stableMessageId(msg, index) === anchor.anchorStableId) return true;
  return msg?.timestamp === anchor.anchorTimestamp;
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

  const textBlock = { type: "text", text: suffix };
  if (msg.role !== "assistant") {
    msg.content = [...msg.content, textBlock];
    return;
  }

  // Keep provider ordering constraints: assistant text must appear before
  // toolCall blocks for models that enforce text/thinking/tool_use ordering.
  const firstToolCallIdx = msg.content.findIndex((block: any) => block?.type === "toolCall");
  if (firstToolCallIdx === -1) {
    msg.content = [...msg.content, textBlock];
  } else {
    msg.content = [
      ...msg.content.slice(0, firstToolCallIdx),
      textBlock,
      ...msg.content.slice(firstToolCallIdx),
    ];
  }
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
      `Recommended range candidate: ${candidate.startId}..${candidate.endId} (${candidate.messageCount} messages, ~${candidate.estimatedTokens} tokens, ${candidate.reason}). Compress this before the next search/read/test if it is closed.`,
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
        .join(", ")}. High-priority stale messages MUST be compressed once their full text is no longer needed. Batch multiple messages in one compress call when possible.`,
    );
  }

  const activeBlocks = formatActiveBlocks(state);
  if (activeBlocks) parts.push(activeBlocks);

  if (parts.length === 0) {
    parts.push("No automatic candidate is certain; scan the older closed context now and compress any completed research, implementation, verification, CI-log inspection, or dead-end debugging slice before accumulating more tool output.");
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
  options: { contextPercent?: number } = {},
): { anchor: DcpNudgeAnchor | null; created: boolean; updated: boolean } {
  const target = findAnchorMessage(messages);
  if (!target) return { anchor: null, created: false, updated: false };

  const key = `${target.stableId}|${target.timestamp}`;
  const existing = state.nudgeAnchors.find(
    (anchor) => `${anchor.anchorStableId ?? ""}|${anchor.anchorTimestamp}` === key,
  );

  const now = Date.now();
  if (existing) {
    const shouldUpgrade = typePriority(type) > typePriority(existing.type);
    if (shouldUpgrade) existing.type = type;
    existing.updatedAt = now;
    existing.contextPercent = options.contextPercent ?? existing.contextPercent;
    state.lastNudge = {
      type: existing.type,
      anchorId: existing.id,
      anchorTimestamp: existing.anchorTimestamp,
      anchorStableId: existing.anchorStableId,
      contextPercent: existing.contextPercent,
      createdAt: now,
    };
    return { anchor: existing, created: false, updated: shouldUpgrade };
  }

  const anchor: DcpNudgeAnchor = {
    id: state.nextNudgeAnchorId++,
    type,
    anchorTimestamp: target.timestamp,
    anchorStableId: target.stableId,
    anchorRole: target.role,
    turnIndex: state.currentTurn,
    contextPercent: options.contextPercent,
    createdAt: now,
    updatedAt: now,
  };
  state.nudgeAnchors.push(anchor);
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
): void {
  if (state.nudgeAnchors.length === 0) return;

  const activeAnchors: DcpNudgeAnchor[] = [];
  for (const anchor of state.nudgeAnchors) {
    const index = messages.findIndex((msg, messageIndex) => anchorMatchesMessage(anchor, msg, messageIndex));
    if (index === -1) continue;
    activeAnchors.push(anchor);
    appendTextToMessage(messages[index], render(anchor));
  }

  state.nudgeAnchors = activeAnchors;
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
    0.4,
  );
  const maxContextPercent = coercePercentThreshold(
    thresholds.maxContextPercent ?? config.compress.maxContextPercent,
    0.8,
  );
  const cadence = Math.max(1, Math.floor(nudgeFrequency));

  if (!Number.isFinite(contextPercent)) return null;
  if (contextPercent <= minContextPercent) return null;
  if (state.nudgeCounter + 1 < cadence) return null;

  if (contextPercent > maxContextPercent) {
    return nudgeForce === "strong" ? "context-strong" : "context-soft";
  }

  if (toolCallsSinceLastUser >= iterationNudgeThreshold) {
    return "iteration";
  }

  return "turn";
}
