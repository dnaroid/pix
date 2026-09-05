import type { DcpConfig } from "./config.js";
import type { DcpState } from "./state.js";
import type { CompressionCandidate, MessageCompressionCandidate } from "./pruner-types.js";
import {
  estimateMessageTokens,
  extractBlockId,
  messageText,
} from "./pruner-metadata.js";
import { stableMessageKeys } from "./pruner-message-ids.js";
import { detectToolGroupSpans, findConversationIndexEntry } from "./conversation-index.js";

interface CandidateBoundary {
  id: string;
  messageIndex: number;
  role: string;
  timestamp: number;
  tokenEstimate: number;
  blockId?: number;
  isSystemReminder: boolean;
}

function assistantToolCallIds(message: any): string[] {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content
    .filter((part: any) => part?.type === "toolCall" && typeof part.id === "string")
    .map((part: any) => part.id as string);
}

function isRealUserBoundary(boundary: CandidateBoundary): boolean {
  return boundary.role === "user" && boundary.blockId === undefined && !boundary.isSystemReminder;
}

function buildCandidateBoundaries(
  messages: any[],
  state: DcpState,
  options: { allowBlocks: boolean },
): CandidateBoundary[] {
  const boundaries: CandidateBoundary[] = [];
  const stableKeys = stableMessageKeys(messages);
  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index];
    const boundary = resolveAddressableBoundaryId(msg, stableKeys[index]!, state, options);
    if (!boundary) continue;
    if (!Number.isFinite(msg.timestamp)) continue;
    boundaries.push({
      id: boundary.id,
      messageIndex: index,
      role: msg.role ?? "",
      timestamp: msg.timestamp,
      tokenEstimate: state.messageMetaSnapshot.get(boundary.id)?.tokenEstimate ?? estimateMessageTokens(msg),
      blockId: boundary.blockId,
      isSystemReminder: msg?._dcpOrigin === "dcp-control",
    });
  }
  return boundaries;
}

function hasAddressableSnapshot(state: DcpState): boolean {
  return state.messageMetaSnapshot.size > 0 || state.messageIdSnapshot.size > 0;
}

function isActiveBlockId(blockId: number, state: DcpState): boolean {
  return state.compressionBlocks.some((block) => block.id === blockId && block.active);
}

function findCurrentMessageId(msg: any, stableKey: string, state: DcpState): string | undefined {
  const role = msg?.role ?? "";
  const timestamp = msg?.timestamp;
  if (!Number.isFinite(timestamp)) return undefined;

  for (const [id, meta] of state.messageMetaSnapshot) {
    if (meta.stableId === stableKey) return id;
  }

  // Backward compatibility for snapshots created before stable IDs were
  // recorded. Never mix timestamp fallback with a modern stable-ID snapshot.
  const isLegacySnapshot = [...state.messageMetaSnapshot.values()]
    .every((meta) => meta.stableId === undefined);
  if (!isLegacySnapshot) return undefined;

  for (const [id, meta] of state.messageMetaSnapshot) {
    if (
      meta.timestamp === timestamp &&
      meta.role === role &&
      meta.blockId === undefined
    ) return id;
  }

  for (const [id, ts] of state.messageIdSnapshot) {
    if (ts === timestamp) return id;
  }

  return undefined;
}

function resolveAddressableBoundaryId(
  msg: any,
  stableKey: string,
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
  // Resolve the message ID by its persistent stable identity. Timestamp/role
  // matching is retained only for legacy snapshots without stable IDs.
  const currentId = findCurrentMessageId(msg, stableKey, state);
  if (currentId) return { id: currentId, text };

  return null;
}

export interface CompressionCandidateSelectionOptions {
  /** Net projected savings required to restore the current budget. */
  requiredSavingsTokens?: number;
  /** Conservative estimator margin added to the required source size. */
  estimatorMarginTokens?: number;
}

function selectOldestSafePrefix(
  boundaries: CandidateBoundary[],
  state: DcpState,
  settings: { minMessages: number; minTokens: number },
  maxSafeMessageIndex: number,
  options?: CompressionCandidateSelectionOptions,
): CandidateBoundary[] | null {
  if (boundaries.length === 0) return null;
  if (!options || options.requiredSavingsTokens === undefined) {
    let full = boundaries.slice();
    while (full.length > 0 && full[0]!.isSystemReminder) full = full.slice(1);
    while (full.length > 0 && full[full.length - 1]!.isSystemReminder) full = full.slice(0, -1);
    if (full.length < Math.max(1, settings.minMessages)) return null;
    if (full.reduce((sum, boundary) => sum + boundary.tokenEstimate, 0) < settings.minTokens) return null;
    return full;
  }
  const requiredSavings = Math.max(0, Math.floor(options.requiredSavingsTokens));
  const estimatorMargin = Math.max(0, Math.floor(options?.estimatorMarginTokens ?? 0));
  const targetSourceTokens = Math.max(settings.minTokens, requiredSavings + estimatorMargin);
  const minMessages = Math.max(1, settings.minMessages);

  let selectedEnd = -1;
  let selectedTokens = 0;
  for (let index = 0; index < boundaries.length; index++) {
    selectedTokens += boundaries[index]!.tokenEstimate;
    if (index + 1 >= minMessages && selectedTokens >= targetSourceTokens) {
      selectedEnd = index;
      break;
    }
  }
  if (selectedEnd < 0) selectedEnd = boundaries.length - 1;

  let selected = boundaries.slice(0, selectedEnd + 1);
  if (state.conversationIndexSnapshot.length > 0) {
    const groups = detectToolGroupSpans(state.conversationIndexSnapshot);
    const startMessageIndex = selected[0]!.messageIndex;
    let endMessageIndex = selected[selected.length - 1]!.messageIndex;
    let changed = true;
    while (changed) {
      changed = false;
      for (const group of groups) {
        const overlaps = group.startIndex <= endMessageIndex && group.endIndex >= startMessageIndex;
        if (!overlaps) continue;
        if (!group.complete) return null;
        if (group.endIndex > endMessageIndex) {
          if (group.endIndex > maxSafeMessageIndex) return null;
          endMessageIndex = group.endIndex;
          changed = true;
        }
      }
    }
    selected = boundaries.filter((boundary) => boundary.messageIndex <= endMessageIndex);
  }

  while (selected.length > 0 && selected[0]!.isSystemReminder) selected = selected.slice(1);
  while (selected.length > 0 && selected[selected.length - 1]!.isSystemReminder) selected = selected.slice(0, -1);
  if (selected.length < minMessages) return null;
  if (selected.reduce((sum, boundary) => sum + boundary.tokenEstimate, 0) < settings.minTokens) return null;
  return selected;
}

export function detectCompressionCandidate(
  messages: any[],
  _state: DcpState,
  config: DcpConfig,
  contextPercent: number,
  options?: CompressionCandidateSelectionOptions,
): CompressionCandidate | null {
  const settings = config.compress.autoCandidates;
  if (!settings.enabled) return null;
  if (contextPercent < settings.minContextPercent) return null;

  const boundaries = buildCandidateBoundaries(messages, _state, { allowBlocks: true });

  if (boundaries.length < settings.minMessages) return null;

  const keepRecentTurns = Math.max(1, settings.keepRecentTurns);
  let recentUserTurns = 0;
  let cutoffIndex = -1;

  for (let i = boundaries.length - 1; i >= 0; i--) {
    const boundary = boundaries[i]!;
    if (!isRealUserBoundary(boundary)) continue;
    recentUserTurns++;
    if (recentUserTurns >= keepRecentTurns) {
      cutoffIndex = i - 1;
      break;
    }
  }

  if (cutoffIndex < 0) return null;

  const eligible = boundaries.slice(0, cutoffIndex + 1);
  const candidate = selectOldestSafePrefix(
    eligible,
    _state,
    settings,
    eligible[eligible.length - 1]?.messageIndex ?? -1,
    options,
  );
  if (!candidate) return null;

  const estimatedTokens = candidate.reduce((sum, item) => sum + item.tokenEstimate, 0);

  const includedBlockIds = Array.from(
    new Set(candidate.map((item) => item.blockId).filter((id): id is number => id !== undefined)),
  );

  return {
    startId: candidate[0]!.id,
    endId: candidate[candidate.length - 1]!.id,
    messageCount: candidate.length,
    estimatedTokens,
    includedBlockIds,
    reason: options?.requiredSavingsTokens
      ? `minimal oldest protocol-safe prefix restoring ~${Math.max(0, Math.floor(options.requiredSavingsTokens))} budget tokens; older than the most recent ${keepRecentTurns} user turn(s)`
      : `older than the most recent ${keepRecentTurns} user turn(s)`,
  };
}

/**
 * Emergency-only range candidate for marathon turns.
 *
 * Normal candidates deliberately protect the newest N user turns. That means a
 * single user task can never produce a range candidate no matter how many
 * provider transactions follow it. Above the configured max-context threshold,
 * this detector instead keeps the user request plus a live tail of recent tool
 * transactions and exposes only the older, provider-committed prefix.
 *
 * The newest assistant group is always retained, even when
 * keepRecentToolPairs=0, so the in-flight request/result head is never selected.
 * For older tool groups, a later assistant is only structural ordering evidence:
 * every tool result selected for compression must also have completed provider
 * evidence in `providerSeenToolIds`. Unknown evidence truncates the safe prefix.
 */
export function detectEmergencyCompressionCandidate(
  messages: any[],
  state: DcpState,
  config: DcpConfig,
  contextPercent: number,
  maxContextPercent: number,
  options?: CompressionCandidateSelectionOptions,
): CompressionCandidate | null {
  const settings = config.compress.autoCandidates;
  const emergencySettings = config.strategies.emergencyCurrentTurnPruning;
  // `autoCandidates.enabled` controls routine advisory suggestions only. The
  // emergency planner is a safety path and is gated by its own destructive
  // policy (`emergencyCurrentTurnPruning.enabled` / autoCompress at commit).
  // Reuse autoCandidates sizing knobs without letting its advisory toggle
  // silently disable emergency range planning.
  if (!emergencySettings.enabled) return null;
  if (contextPercent <= maxContextPercent) return null;

  const boundaries = buildCandidateBoundaries(messages, state, { allowBlocks: true });
  if (boundaries.length < settings.minMessages) return null;

  let latestUserIndex = -1;
  for (let index = boundaries.length - 1; index >= 0; index--) {
    if (!isRealUserBoundary(boundaries[index]!)) continue;
    latestUserIndex = boundaries[index]!.messageIndex;
    break;
  }
  if (latestUserIndex < 0) return null;

  const assistantIndexes: number[] = [];
  for (let index = latestUserIndex + 1; index < messages.length; index++) {
    if (messages[index]?.role === "assistant") assistantIndexes.push(index);
  }
  if (assistantIndexes.length < 2) return null;

  // Always keep the newest assistant group as the live head. Then extend the
  // preserved head backwards until it contains the requested number of newest
  // complete tool-call/result pairs. Grouping by assistant avoids splitting a
  // parallel tool-call transaction.
  const keepRecentPairs = Math.max(0, Math.floor(emergencySettings.keepRecentToolPairs));
  let preservedPairs = 0;
  let preservedHeadStart = assistantIndexes[assistantIndexes.length - 1]!;
  for (let assistantPos = assistantIndexes.length - 1; assistantPos >= 0; assistantPos--) {
    const assistantIndex = assistantIndexes[assistantPos]!;
    preservedHeadStart = assistantIndex;
    const nextAssistantIndex = assistantIndexes[assistantPos + 1] ?? messages.length;
    const callIds = new Set(assistantToolCallIds(messages[assistantIndex]));
    if (callIds.size > 0) {
      const completedIds = new Set<string>();
      for (let index = assistantIndex + 1; index < nextAssistantIndex; index++) {
        const message = messages[index];
        if (
          message?.role === "toolResult" &&
          typeof message.toolCallId === "string" &&
          callIds.has(message.toolCallId)
        ) {
          completedIds.add(message.toolCallId);
        }
      }
      preservedPairs += completedIds.size;
    }
    if (assistantPos === assistantIndexes.length - 1 && keepRecentPairs === 0) break;
    if (preservedPairs >= keepRecentPairs) break;
  }

  // F09: provider completion evidence is authoritative for tool-result
  // eligibility in both emergency range and output-pruning paths. A later
  // assistant establishes ordering only; it cannot prove that an earlier tool
  // result survived serialization + stream completion. Stop before the first
  // group whose evidence is incomplete/unknown rather than silently spanning it.
  let evidenceSafeEnd = preservedHeadStart - 1;
  const groups = detectToolGroupSpans(state.conversationIndexSnapshot);
  for (const group of groups) {
    if (group.endIndex <= latestUserIndex) continue;
    if (group.startIndex >= preservedHeadStart) break;
    if (!group.complete || group.toolCallIds.some((id) => !state.providerSeenToolIds.has(id))) {
      evidenceSafeEnd = Math.min(evidenceSafeEnd, group.startIndex - 1);
      break;
    }
  }

  const eligible = boundaries.filter((boundary) =>
    boundary.messageIndex > latestUserIndex &&
    boundary.messageIndex <= evidenceSafeEnd,
  );
  const candidate = selectOldestSafePrefix(
    eligible,
    state,
    settings,
    preservedHeadStart - 1,
    options,
  );
  if (!candidate) return null;

  // Independent fail-closed guard for legacy/partial snapshots where the
  // canonical group index may be unavailable. Structural ordering is never
  // enough to authorize deletion of an unseen tool result.
  const selectedStart = candidate[0]!.messageIndex;
  const selectedEnd = candidate[candidate.length - 1]!.messageIndex;
  for (let index = selectedStart; index <= selectedEnd; index++) {
    const message = messages[index];
    if (
      (message?.role === "toolResult" || message?.role === "bashExecution") &&
      typeof message.toolCallId === "string" &&
      !state.providerSeenToolIds.has(message.toolCallId)
    ) return null;
  }

  const estimatedTokens = candidate.reduce((sum, item) => sum + item.tokenEstimate, 0);

  const includedBlockIds = Array.from(
    new Set(candidate.map((item) => item.blockId).filter((id): id is number => id !== undefined)),
  );

  return {
    startId: candidate[0]!.id,
    endId: candidate[candidate.length - 1]!.id,
    messageCount: candidate.length,
    estimatedTokens,
    includedBlockIds,
    reason: options?.requiredSavingsTokens
      ? `minimal emergency same-turn provider-evidenced prefix restoring ~${Math.max(0, Math.floor(options.requiredSavingsTokens))} budget tokens; preserves newest ${keepRecentPairs} tool pair(s) plus the live assistant head`
      : `emergency same-turn provider-evidenced prefix; preserves newest ${keepRecentPairs} tool pair(s) plus the live assistant head`,
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

  const boundaries = buildCandidateBoundaries(messages, state, { allowBlocks: false })
    .filter((boundary) => boundary.blockId === undefined);

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

  // If the transcript does not yet contain enough complete user turns to
  // satisfy the retention policy, every message belongs to the protected
  // recent window. Do not reinterpret the live head as stale history.
  if (recentUserTurns < keepRecentTurns || cutoffIndex < 0) return [];

  const mediumTokens = Math.max(1, settings.mediumTokens ?? 500);
  const highTokens = Math.max(mediumTokens, settings.highTokens ?? 5000);
  const maxSuggestions = Math.max(1, settings.maxSuggestions ?? 5);

  return boundaries
    .slice(0, cutoffIndex + 1)
    .filter((candidate) => !candidate.isSystemReminder)
    .filter((candidate) => candidate.role !== "user" || !config.compress.protectUserMessages)
    // V2 message mode replaces only the selected body, so completed tool
    // results are safe surgical candidates. Signed assistants and assistants
    // carrying tool calls remain structurally immutable, and an incomplete
    // tool group is still in-flight even if it appears in an unusual snapshot.
    .filter((candidate) => {
      const message = messages[candidate.messageIndex];
      if (candidate.role === "assistant" && assistantToolCallIds(message).length > 0) return false;
      const indexEntry = findConversationIndexEntry(state.conversationIndexSnapshot, candidate.id);
      if (candidate.role === "assistant" && indexEntry?.signedAssistant) return false;
      if (indexEntry) {
        const incompleteGroup = detectToolGroupSpans(state.conversationIndexSnapshot).some((group) =>
          !group.complete && indexEntry.index >= group.startIndex && indexEntry.index <= group.endIndex,
        );
        if (incompleteGroup) return false;
      }
      return true;
    })
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
