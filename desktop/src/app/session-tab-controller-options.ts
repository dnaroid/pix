import type { AcpClient } from "../lib/acp-client";
import type { ActiveSessionState } from "./active-session-state.svelte";
import type { createDraftSession } from "./draft-session.svelte";
import type { createSessionCatalog } from "./session-catalog.svelte";
import type { createSessionHistory } from "./session-history.svelte";
import type { createSessionRuntimeStore } from "./session-runtime.svelte";
import type { createSessionTabsState } from "./session-tabs-state.svelte";

type SessionCatalog = ReturnType<typeof createSessionCatalog>;
type SessionHistory = ReturnType<typeof createSessionHistory>;
type SessionRuntime = ReturnType<typeof createSessionRuntimeStore>;
type SessionTabsState = ReturnType<typeof createSessionTabsState>;
type DraftSession = ReturnType<typeof createDraftSession>;

export type SessionTabControllerOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  statusReady: () => boolean;
  canUseSession: () => boolean;
  sessionMutationRunning: () => boolean;
  state: ActiveSessionState;
  operationRunning: () => boolean;
  setOperationRunning: (running: boolean) => void;
  promptRunning: (sessionId: string) => boolean;
  catalog: SessionCatalog;
  tabs: SessionTabsState;
  draft: DraftSession;
  runtime: SessionRuntime;
  history: SessionHistory;
  closeProjectSelector: () => void;
  clearSessionActivity: (sessionId: string) => void;
  resetSessionActivity: () => void;
  forgetRuntime: (sessionId: string) => void;
  retargetWorkbenchAnchors: (sourceSessionId: string, targetSessionId?: string) => void;
  clearPrompt: () => void;
  invalidateAttachmentDraft: () => void;
  switchComposerDraft: (
    sourceOwnerId: string | null | undefined,
    targetOwnerId: string,
    options?: { resetTarget?: boolean; preserveSource?: boolean },
  ) => void;
  forgetComposerDraft: (ownerId: string) => void;
  resetComposerDrafts: () => void;
  tabSessionIds: () => readonly string[];
  focusComposer: () => void | Promise<void>;
  refreshQueueState: (sessionId: string) => void | Promise<void>;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
};

export type SessionLoader = (sessionId: string) => Promise<void>;
export type SessionReplacer = (sessionId: string) => Promise<void>;
