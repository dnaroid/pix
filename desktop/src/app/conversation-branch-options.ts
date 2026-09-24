import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../lib/acp-client";
import type { Attachment } from "../lib/attachments";
import type { ActiveSessionState } from "./active-session-state.svelte";

export type ConversationBranchActionsOptions = {
  client: () => AcpClient | null;
  state: ActiveSessionState;
  workspace: () => string;
  operationRunning: () => boolean;
  setOperationRunning: (running: boolean) => void;
  promptRunning: () => boolean;
  sessionHistoryLoading: () => boolean;
  closeProjectSelector: () => void;
  closeSessionSelector: () => void;
  clearCommandPicker: () => void;
  forgetRuntime: (sessionId: string) => void;
  clearSessionActivity: (sessionId: string) => void;
  markRuntimeReady: (sessionId: string, options: SessionConfigOption[]) => void;
  beginHistoryLoad: () => number;
  isHistoryLoadCurrent: (client: AcpClient, sessionId: string, workspace: string, generation: number) => boolean;
  hydrateHistory: (
    client: AcpClient,
    sessionId: string,
    workspace: string,
    generation: number,
  ) => Promise<void>;
  cancelHistoryLoad: () => void;
  markHistoryFullyLoaded: (sessionId: string) => void;
  markSourceClosed: (sessionId: string) => void;
  ensureProvisionalSession: (sessionId: string, workspace: string) => void;
  showSessionTab: (sessionId: string) => void;
  rememberActiveSession: (workspace: string, sessionId: string) => void;
  nextLocalMessageId: () => string;
  setPromptText: (text: string) => void;
  setPromptAttachments: (attachments: Attachment[]) => void;
  invalidateAttachmentDraft: () => void;
  refreshSessions: () => void | Promise<void>;
  scrollToLatest: () => Promise<void>;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
};

export type ForkConversation = (
  requestedEntryId?: string,
  config?: { keepSourceOpen?: boolean },
) => Promise<void>;
