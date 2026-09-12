import type { AcpClient, QueuedUserMessage } from "../lib/acp-client";

export type PromptRuntimeOptions = {
  client: () => AcpClient | null;
  activeSessionId: () => string | null;
  runtimeReady: (sessionId: string) => boolean;
  operationRunning: () => boolean;
  sessionHistoryLoading: () => boolean;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
  refreshRuntimeStatus: (sessionId: string) => void | Promise<void>;
  appendQueuedMessage: (sessionId: string, message: QueuedUserMessage) => string;
  bindPromptSessionEntry: (
    sessionId: string,
    transcriptMessageId: string,
    sessionEntryId: string | undefined,
  ) => void;
  finalizeTranscriptActivity: (sessionId: string, endedAtMs: number) => void;
};
