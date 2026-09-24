import type { StopReason } from "@agentclientprotocol/sdk";
import type { AcpClient, QueuedUserMessage } from "../lib/acp-client";

export type PromptRuntimeOptions = {
  client: () => AcpClient | null;
  activeSessionId: () => string | null;
  runtimeReady: (sessionId: string) => boolean;
  operationRunning: () => boolean;
  sessionHistoryLoading: () => boolean;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
  appendQueuedMessage: (sessionId: string, message: QueuedUserMessage) => string;
  bindPromptSessionEntry: (
    sessionId: string,
    transcriptMessageId: string,
    sessionEntryId: string | undefined,
  ) => void;
  finalizeTranscriptActivity: (sessionId: string, endedAtMs: number) => void;
  onPromptStarted?: (sessionId: string) => void;
  onPromptSettled?: (sessionId: string, stopReason: StopReason) => void;
  onPromptError?: (sessionId: string, error: unknown) => void;
  onAgentPaused?: (sessionId: string) => void;
  onSessionCleared?: (sessionId: string) => void;
  onReset?: () => void;
};
