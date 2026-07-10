import type { DcpConfig } from "./config.js";
import { estimateMessageTokens, extractBlockId, messageText } from "./pruner-metadata.js";
import type {
  EmergencyCurrentTurnOutput,
  EmergencyCurrentTurnSelection,
  MessageCompressionCandidate,
} from "./pruner-types.js";
import {
  EMERGENCY_CURRENT_TURN_PLACEHOLDER,
  isToolRecordProtected,
  markToolPruned,
} from "./pruner-tools.js";
import type { DcpState } from "./state.js";

function emptySelection(): EmergencyCurrentTurnSelection {
  return {
    eligible: [],
    stats: {
      totalPairs: 0,
      totalPairTokens: 0,
      eligiblePairs: 0,
      eligibleTokens: 0,
      eligibleRecoverableTokens: 0,
      preservedPairs: 0,
      preservedTokens: 0,
      preservedRecentPairs: 0,
      preservedRecentTokens: 0,
      preservedUnseenPairs: 0,
      preservedUnseenTokens: 0,
      preservedProtectedPairs: 0,
      preservedProtectedTokens: 0,
    },
  };
}

export function emergencyPressureState(
  contextPercent: number,
  maxContextPercent: number,
  hardContextPercent: number,
): { hardEmergencyReached: boolean; contextLimitReached: boolean; emergencyPressureReached: boolean } {
  const hardEmergencyReached = contextPercent >= Math.max(0, Math.min(1, hardContextPercent));
  const contextLimitReached = contextPercent > maxContextPercent;
  return {
    hardEmergencyReached,
    contextLimitReached,
    emergencyPressureReached: hardEmergencyReached || contextLimitReached,
  };
}

function isRealUserMessage(message: any): boolean {
  if (message?.role !== "user") return false;
  const text = messageText(message);
  return !text.includes("<dcp-system-reminder>") && extractBlockId(text) === undefined;
}

function assistantToolCallIds(message: any): string[] {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content
    .filter((part: any) => part?.type === "toolCall" && typeof part.id === "string")
    .map((part: any) => part.id as string);
}

function messageIdForResult(message: any, state: DcpState): string | undefined {
  for (const [id, meta] of state.messageMetaSnapshot) {
    if (
      meta.blockId === undefined &&
      meta.toolCallId === message.toolCallId &&
      meta.role === message.role &&
      meta.timestamp === message.timestamp
    ) return id;
  }
  return undefined;
}

function hasProtectedTag(message: any, config: DcpConfig): boolean {
  return config.compress.protectTags && /<protect\b[^>]*>[\s\S]*?<\/protect>/i.test(messageText(message));
}

export function analyzeEmergencyCurrentTurn(
  messages: any[],
  state: DcpState,
  config: DcpConfig,
): EmergencyCurrentTurnSelection {
  const settings = config.strategies.emergencyCurrentTurnPruning;
  if (!settings.enabled) return emptySelection();
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isRealUserMessage(messages[index])) {
      latestUserIndex = index;
      break;
    }
  }

  if (latestUserIndex < 0) {
    return emptySelection();
  }

  const pairedCallIds = new Set<string>();
  for (let index = latestUserIndex + 1; index < messages.length; index++) {
    for (const toolCallId of assistantToolCallIds(messages[index])) pairedCallIds.add(toolCallId);
  }

  const pairs: Array<EmergencyCurrentTurnOutput & { message: any }> = [];
  for (let index = latestUserIndex + 1; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== "toolResult") continue;
    if (typeof message.toolCallId !== "string" || !pairedCallIds.has(message.toolCallId)) continue;
    const record = state.toolCalls.get(message.toolCallId);
    const tokenEstimate = Math.max(record?.tokenEstimate ?? 0, estimateMessageTokens(message));
    const placeholderEstimate = estimateMessageTokens({
      ...message,
      content: [{ type: "text", text: EMERGENCY_CURRENT_TURN_PLACEHOLDER }],
    });
    pairs.push({
      toolCallId: message.toolCallId,
      messageId: messageIdForResult(message, state),
      toolName: record?.toolName ?? message.toolName ?? "",
      tokenEstimate,
      recoverableTokens: Math.max(0, tokenEstimate - placeholderEstimate),
      resultIndex: index,
      message,
    });
  }

  const keepRecent = Math.max(0, Math.floor(settings.keepRecentToolPairs));
  const recentIds = new Set(pairs.slice(Math.max(0, pairs.length - keepRecent)).map((pair) => pair.toolCallId));
  const eligible: EmergencyCurrentTurnOutput[] = [];
  const preservedIds = new Set<string>();
  let preservedTokens = 0;
  let preservedRecentPairs = 0;
  let preservedRecentTokens = 0;
  let preservedUnseenPairs = 0;
  let preservedUnseenTokens = 0;
  let preservedProtectedPairs = 0;
  let preservedProtectedTokens = 0;

  const preserve = (
    pair: EmergencyCurrentTurnOutput,
    reason: "recent" | "unseen" | "protected" | "other",
  ): void => {
    if (!preservedIds.has(pair.toolCallId)) {
      preservedIds.add(pair.toolCallId);
      preservedTokens += pair.tokenEstimate;
    }
    if (reason === "recent") {
      preservedRecentPairs++;
      preservedRecentTokens += pair.tokenEstimate;
    } else if (reason === "unseen") {
      preservedUnseenPairs++;
      preservedUnseenTokens += pair.tokenEstimate;
    } else if (reason === "protected") {
      preservedProtectedPairs++;
      preservedProtectedTokens += pair.tokenEstimate;
    }
  };

  for (const pair of pairs) {
    if (recentIds.has(pair.toolCallId)) {
      preserve(pair, "recent");
      continue;
    }
    if (!state.providerSeenToolIds.has(pair.toolCallId)) {
      preserve(pair, "unseen");
      continue;
    }
    const record = state.toolCalls.get(pair.toolCallId);
    if (
      !record ||
      isToolRecordProtected(record, config, settings.protectedTools) ||
      hasProtectedTag(pair.message, config)
    ) {
      preserve(pair, "protected");
      continue;
    }
    if (
      state.prunedToolIds.has(pair.toolCallId) ||
      pair.tokenEstimate < Math.max(1, settings.minOutputTokens) ||
      pair.recoverableTokens <= 0
    ) {
      preserve(pair, "other");
      continue;
    }
    eligible.push({
      toolCallId: pair.toolCallId,
      messageId: pair.messageId,
      toolName: pair.toolName,
      tokenEstimate: pair.tokenEstimate,
      recoverableTokens: pair.recoverableTokens,
      resultIndex: pair.resultIndex,
    });
  }

  eligible.sort((a, b) =>
    a.resultIndex - b.resultIndex ||
    b.tokenEstimate - a.tokenEstimate ||
    a.toolCallId.localeCompare(b.toolCallId),
  );
  return {
    eligible,
    stats: {
      totalPairs: pairs.length,
      totalPairTokens: pairs.reduce((sum, pair) => sum + pair.tokenEstimate, 0),
      eligiblePairs: eligible.length,
      eligibleTokens: eligible.reduce((sum, pair) => sum + pair.tokenEstimate, 0),
      eligibleRecoverableTokens: eligible.reduce((sum, pair) => sum + pair.recoverableTokens, 0),
      preservedPairs: preservedIds.size,
      preservedTokens,
      preservedRecentPairs,
      preservedRecentTokens,
      preservedUnseenPairs,
      preservedUnseenTokens,
      preservedProtectedPairs,
      preservedProtectedTokens,
    },
  };
}

export function emergencyCurrentTurnMessageCandidates(
  selection: EmergencyCurrentTurnSelection,
  config: DcpConfig,
): MessageCompressionCandidate[] {
  const settings = config.strategies.emergencyCurrentTurnPruning;
  if (!settings.enabled) return [];
  const maxSuggestions = Math.max(1, Math.floor(settings.maxSuggestions));
  const highTokens = Math.max(1, config.compress.messageMode.highTokens);
  return selection.eligible
    .filter((output) => output.messageId !== undefined)
    .slice(0, maxSuggestions)
    .map((output) => ({
      messageId: output.messageId!,
      role: "toolResult",
      estimatedTokens: output.tokenEstimate,
      priority: output.tokenEstimate >= highTokens ? "high" : "medium",
      reason: `old same-turn tool output; newest ${settings.keepRecentToolPairs} complete pair(s) preserved`,
    }));
}

export function pruneEmergencyCurrentTurn(
  selection: EmergencyCurrentTurnSelection,
  state: DcpState,
  targetRecoveryTokens: number,
): { prunedToolCallIds: string[]; estimatedTokensRecovered: number } {
  const prunedToolCallIds: string[] = [];
  let estimatedTokensRecovered = 0;
  const target = Math.max(1, Math.ceil(targetRecoveryTokens));
  for (const output of selection.eligible) {
    if (estimatedTokensRecovered >= target) break;
    if (markToolPruned(state, output.toolCallId, "emergency-current-turn", output.recoverableTokens)) {
      prunedToolCallIds.push(output.toolCallId);
      estimatedTokensRecovered += output.recoverableTokens;
    }
  }
  return { prunedToolCallIds, estimatedTokensRecovered };
}
