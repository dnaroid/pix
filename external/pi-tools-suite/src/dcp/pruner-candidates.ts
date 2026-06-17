import type { DcpConfig } from "./config.js";
import type { DcpState } from "./state.js";
import type { CompressionCandidate, MessageCompressionCandidate } from "./pruner-types.js";
import {
  estimateMessageTokens,
  extractBlockId,
  messageText,
} from "./pruner-metadata.js";

interface CandidateBoundary {
  id: string;
  role: string;
  timestamp: number;
  tokenEstimate: number;
  blockId?: number;
  isSystemReminder: boolean;
}

function hasAddressableSnapshot(state: DcpState): boolean {
  return state.messageMetaSnapshot.size > 0 || state.messageIdSnapshot.size > 0;
}

function isActiveBlockId(blockId: number, state: DcpState): boolean {
  return state.compressionBlocks.some((block) => block.id === blockId && block.active);
}

function findCurrentMessageId(msg: any, state: DcpState): string | undefined {
  const role = msg?.role ?? "";
  const timestamp = msg?.timestamp;
  if (!Number.isFinite(timestamp)) return undefined;

  for (const [id, meta] of state.messageMetaSnapshot) {
    if (meta.timestamp === timestamp && meta.role === role && meta.blockId === undefined) return id;
  }

  for (const [id, ts] of state.messageIdSnapshot) {
    if (ts === timestamp) return id;
  }

  return undefined;
}

function resolveAddressableBoundaryId(
  msg: any,
  state: DcpState,
  options: { allowBlocks: boolean },
): { id: string; blockId?: number; text: string } | null {
  const text = messageText(msg);
  const blockId = extractBlockId(text);
  if (blockId !== undefined) {
    if (options.allowBlocks && isActiveBlockId(blockId, state)) return { id: `b${blockId}`, blockId, text };
    if (!hasAddressableSnapshot(state) && options.allowBlocks) return { id: `b${blockId}`, blockId, text };
    return null;
  }

  // Inline [dcp-id] markers are no longer injected into message content; the
  // snapshot rebuilt by injectMessageIds() is the sole addressability source.
  // Resolve the message id by matching its (timestamp, role) in the snapshot.
  const currentId = findCurrentMessageId(msg, state);
  if (currentId) return { id: currentId, text };

  return null;
}

export function detectCompressionCandidate(
  messages: any[],
  _state: DcpState,
  config: DcpConfig,
  contextPercent: number,
): CompressionCandidate | null {
  const settings = config.compress.autoCandidates;
  if (!settings.enabled) return null;
  if (contextPercent < settings.minContextPercent) return null;

  const boundaries: CandidateBoundary[] = [];
  for (const msg of messages) {
    const boundary = resolveAddressableBoundaryId(msg, _state, { allowBlocks: true });
    if (!boundary) continue;
    if (!Number.isFinite(msg.timestamp)) continue;
    boundaries.push({
      id: boundary.id,
      role: msg.role ?? "",
      timestamp: msg.timestamp,
      tokenEstimate: estimateMessageTokens(msg),
      blockId: boundary.blockId,
      isSystemReminder: boundary.text.includes("<dcp-system-reminder>"),
    });
  }

  if (boundaries.length < settings.minMessages) return null;

  const keepRecentTurns = Math.max(1, settings.keepRecentTurns);
  let recentUserTurns = 0;
  let cutoffIndex = -1;

  for (let i = boundaries.length - 1; i >= 0; i--) {
    const boundary = boundaries[i]!;
    const isRealUserMessage =
      boundary.role === "user" && boundary.blockId === undefined && !boundary.isSystemReminder;
    if (!isRealUserMessage) continue;
    recentUserTurns++;
    if (recentUserTurns >= keepRecentTurns) {
      cutoffIndex = i - 1;
      break;
    }
  }

  if (cutoffIndex < 0) return null;

  let candidate = boundaries.slice(0, cutoffIndex + 1);
  while (candidate.length > 0 && candidate[0]!.isSystemReminder) candidate = candidate.slice(1);
  while (candidate.length > 0 && candidate[candidate.length - 1]!.isSystemReminder) {
    candidate = candidate.slice(0, -1);
  }

  if (candidate.length < settings.minMessages) return null;

  const estimatedTokens = candidate.reduce((sum, item) => sum + item.tokenEstimate, 0);
  if (estimatedTokens < settings.minTokens) return null;

  const includedBlockIds = Array.from(
    new Set(candidate.map((item) => item.blockId).filter((id): id is number => id !== undefined)),
  );

  return {
    startId: candidate[0]!.id,
    endId: candidate[candidate.length - 1]!.id,
    messageCount: candidate.length,
    estimatedTokens,
    includedBlockIds,
    reason: `older than the most recent ${keepRecentTurns} user turn(s)`,
  };
}

export function formatCompressionCandidateHint(candidate: CompressionCandidate): string {
  const blockHint = candidate.includedBlockIds.length > 0
    ? `\nThis candidate includes compressed block(s): ${candidate.includedBlockIds
        .map((id) => `b${id}`)
        .join(", ")}. If you compress this range, include each required \`(bN)\` placeholder exactly once in the summary.`
    : "";

  return `\n\nSuggested compression candidate: ${candidate.startId}..${candidate.endId} (${candidate.messageCount} messages, ~${candidate.estimatedTokens} tokens, ${candidate.reason}).${blockHint}`;
}

export function detectMessageCompressionCandidates(
  messages: any[],
  state: DcpState,
  config: DcpConfig,
  contextPercent: number,
): MessageCompressionCandidate[] {
  const settings = config.compress.messageMode;
  if (!settings?.enabled) return [];
  if (contextPercent < settings.minContextPercent) return [];

  const boundaries: CandidateBoundary[] = [];
  for (const msg of messages) {
    const boundary = resolveAddressableBoundaryId(msg, state, { allowBlocks: false });
    if (!boundary || boundary.blockId !== undefined) continue;
    if (!Number.isFinite(msg.timestamp)) continue;
    boundaries.push({
      id: boundary.id,
      role: msg.role ?? "",
      timestamp: msg.timestamp,
      tokenEstimate: estimateMessageTokens(msg),
      isSystemReminder: boundary.text.includes("<dcp-system-reminder>"),
    });
  }

  const keepRecentTurns = Math.max(1, settings.keepRecentTurns ?? 2);
  let recentUserTurns = 0;
  let cutoffIndex = boundaries.length - 1;

  for (let i = boundaries.length - 1; i >= 0; i--) {
    const boundary = boundaries[i]!;
    const isRealUserMessage = boundary.role === "user" && !boundary.isSystemReminder;
    if (!isRealUserMessage) continue;
    recentUserTurns++;
    if (recentUserTurns >= keepRecentTurns) {
      cutoffIndex = i - 1;
      break;
    }
  }

  if (cutoffIndex < 0) return [];

  const mediumTokens = Math.max(1, settings.mediumTokens ?? 500);
  const highTokens = Math.max(mediumTokens, settings.highTokens ?? 5000);
  const maxSuggestions = Math.max(1, settings.maxSuggestions ?? 5);

  return boundaries
    .slice(0, cutoffIndex + 1)
    .filter((candidate) => !candidate.isSystemReminder)
    .filter((candidate) => candidate.role !== "user" || !config.compress.protectUserMessages)
    .filter((candidate) => candidate.tokenEstimate >= mediumTokens)
    .map((candidate): MessageCompressionCandidate => ({
      messageId: candidate.id,
      role: candidate.role,
      estimatedTokens: candidate.tokenEstimate,
      priority: candidate.tokenEstimate >= highTokens ? "high" : "medium",
      reason: `older than the most recent ${keepRecentTurns} user turn(s)`,
    }))
    .sort((a, b) => {
      const priorityDiff = (b.priority === "high" ? 1 : 0) - (a.priority === "high" ? 1 : 0);
      if (priorityDiff !== 0) return priorityDiff;
      return b.estimatedTokens - a.estimatedTokens;
    })
    .slice(0, maxSuggestions);
}

export function formatMessageCompressionCandidateHint(candidates: MessageCompressionCandidate[]): string {
  if (candidates.length === 0) return "";
  const entries = candidates
    .map((candidate) => `${candidate.messageId} (${candidate.priority}, ${candidate.role}, ~${candidate.estimatedTokens} tokens)`)
    .join(", ");
  return `\n\nSuggested individual message compression candidates: ${entries}. To compress individual messages, call \`compress\` with a \`messages\` array: { messageId, topic, summary }. Use this for large stale messages when a full range would be too broad.`;
}
