import type { AcpClient } from "../lib/acp-client";
import type { Attachment } from "../lib/attachments";
import type { StopReason } from "@agentclientprotocol/sdk";
import {
  bindLocalUserMessageSessionEntry,
  finalizeTranscriptActivity,
} from "../lib/transcript";
import type { ActiveSessionState } from "./active-session-state.svelte";
import { createPromptRuntime } from "./prompt-runtime.svelte";
import { createQueuedMessageController } from "./queued-messages";
import type { createSessionRuntimeStore } from "./session-runtime.svelte";
import { createSessionUpdateBatcher } from "./session-update-batcher";

type SessionRuntime = ReturnType<typeof createSessionRuntimeStore>;

type DesktopPromptServicesOptions = {
  client: () => AcpClient | null;
  state: ActiveSessionState;
  sessionRuntime: SessionRuntime;
  operationRunning: () => boolean;
  sessionHistoryLoading: () => boolean;
  followsLatest: () => boolean;
  scheduleScrollToLatest: () => void;
  nextAttachmentId: () => string;
  bumpAttachmentGeneration: () => void;
  setPromptText: (text: string) => void;
  setPromptAttachments: (attachments: Attachment[]) => void;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
  onPromptStarted?: (sessionId: string) => void;
  onPromptSettled?: (sessionId: string, stopReason: StopReason) => void;
  onPromptError?: (sessionId: string, error: unknown) => void;
  onSessionCleared?: (sessionId: string) => void;
  onReset?: () => void;
};

export function createDesktopPromptServices(options: DesktopPromptServicesOptions) {
  const queue = createQueuedMessageController({
    state: options.state,
    followsLatest: options.followsLatest,
    scheduleScrollToLatest: options.scheduleScrollToLatest,
    nextAttachmentId: options.nextAttachmentId,
    bumpAttachmentGeneration: options.bumpAttachmentGeneration,
    setPromptText: options.setPromptText,
    setPromptAttachments: options.setPromptAttachments,
  });
  const runtime = createPromptRuntime({
    client: options.client,
    activeSessionId: () => options.state.sessionId,
    runtimeReady: options.sessionRuntime.isReady,
    operationRunning: options.operationRunning,
    sessionHistoryLoading: options.sessionHistoryLoading,
    setErrorMessage: options.setErrorMessage,
    reportError: options.reportError,
    onPromptStarted: options.onPromptStarted,
    onPromptSettled: options.onPromptSettled,
    onPromptError: options.onPromptError,
    onSessionCleared: options.onSessionCleared,
    onReset: options.onReset,
    appendQueuedMessage: queue.appendToTranscript,
    bindPromptSessionEntry: (sessionId, transcriptMessageId, sessionEntryId) => {
      const current = options.state.transcriptFor(sessionId);
      if (!current) return;
      options.state.setTranscriptFor(
        sessionId,
        bindLocalUserMessageSessionEntry(current, transcriptMessageId, sessionEntryId),
      );
    },
    finalizeTranscriptActivity: (sessionId, endedAtMs) => {
      const current = options.state.transcriptFor(sessionId);
      if (!current) return;
      const next = finalizeTranscriptActivity(current, endedAtMs);
      if (next !== current) options.state.setTranscriptFor(sessionId, next);
    },
  });
  const updates = createSessionUpdateBatcher({
    state: options.state,
    promptEndedAt: runtime.endedAt,
    promptRunning: runtime.isRunning,
    clearPromptEndedAt: runtime.clearEndedAt,
    followsLatest: options.followsLatest,
    scheduleScrollToLatest: options.scheduleScrollToLatest,
  });

  return { runtime, queue, updates };
}

export type DesktopPromptServices = ReturnType<typeof createDesktopPromptServices>;
