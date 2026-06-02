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

export type DcpNudgeType = "context-strong" | "context-soft" | "turn" | "iteration";

export interface NudgeThresholds {
  minContextPercent?: number;
  maxContextPercent?: number;
}
