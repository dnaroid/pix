export interface CompressionCandidate {
  startId: string;
  endId: string;
  messageCount: number;
  estimatedTokens: number;
  includedBlockIds: number[];
  reason: string;
}

export type MessagePriority = "medium" | "high";

export interface MessageCompressionCandidate {
  messageId: string;
  role: string;
  estimatedTokens: number;
  priority: MessagePriority;
  reason: string;
}

export interface EmergencyCurrentTurnStats {
  totalPairs: number;
  totalPairTokens: number;
  eligiblePairs: number;
  eligibleTokens: number;
  eligibleRecoverableTokens: number;
  preservedPairs: number;
  preservedTokens: number;
  preservedRecentPairs: number;
  preservedRecentTokens: number;
  preservedUnseenPairs: number;
  preservedUnseenTokens: number;
  preservedProtectedPairs: number;
  preservedProtectedTokens: number;
}

export interface EmergencyCurrentTurnOutput {
  toolCallId: string;
  messageId?: string;
  toolName: string;
  tokenEstimate: number;
  recoverableTokens: number;
  resultIndex: number;
}

export interface EmergencyCurrentTurnSelection {
  eligible: EmergencyCurrentTurnOutput[];
  stats: EmergencyCurrentTurnStats;
}

export type DcpNudgeType = "context-strong" | "context-soft" | "turn" | "iteration";

export interface NudgeThresholds {
  minContextPercent?: number;
  maxContextPercent?: number;
}
