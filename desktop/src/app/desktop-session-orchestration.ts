import type { AcpClient } from "../lib/acp-client";
import type { createActiveSessionState } from "./active-session-state.svelte";
import { createDcpCompression } from "./dcp-compression.svelte";
import type { createDesktopProjectServices } from "./desktop-project-services";
import type { createDesktopPromptServices } from "./desktop-prompt-services";
import type { createDesktopSessionServices } from "./desktop-session-services";
import type { LspOnboardingStore } from "./lsp-onboarding.svelte";
import { createSessionCoordinator } from "./session-coordinator";

type ActiveSessionState = ReturnType<typeof createActiveSessionState>;
type ProjectServices = ReturnType<typeof createDesktopProjectServices>;
type PromptServices = ReturnType<typeof createDesktopPromptServices>;
type SessionServices = ReturnType<typeof createDesktopSessionServices>;

type DesktopSessionOrchestrationOptions = {
  client: () => AcpClient | null;
  activeSessionId: () => string | null;
  operationRunning: () => boolean;
  sessionHistoryLoading: () => boolean;
  dcpCompressionAvailable: () => boolean;
  state: ActiveSessionState;
  closeProjectSelector: () => void;
  closeSessionSelector: () => void;
  clearCommandPicker: () => void;
  cancelAllPendingElicitations: () => void;
  cancelPendingElicitationForSession: (sessionId: string) => void;
  setOperationRunning: (running: boolean) => void;
  sessionServices: SessionServices;
  projectServices: ProjectServices;
  promptServices: PromptServices;
  lspOnboarding: LspOnboardingStore;
  reportError: (error: unknown) => void;
};

export function createDesktopSessionOrchestration(options: DesktopSessionOrchestrationOptions) {
  const dcp = createDcpCompression({
    client: options.client,
    activeSessionId: options.activeSessionId,
    runtime: options.sessionServices.runtime,
    prompts: options.promptServices.runtime,
    operationRunning: options.operationRunning,
    sessionHistoryLoading: options.sessionHistoryLoading,
    available: options.dcpCompressionAvailable,
    reportError: options.reportError,
  });

  const coordinator = createSessionCoordinator({
    state: options.state,
    closeProjectSelector: options.closeProjectSelector,
    closeSessionSelector: options.closeSessionSelector,
    clearCommandPicker: options.clearCommandPicker,
    cancelAllPendingElicitations: options.cancelAllPendingElicitations,
    cancelPendingElicitationForSession: options.cancelPendingElicitationForSession,
    setOperationRunning: options.setOperationRunning,
    runtime: options.sessionServices.runtime,
    activity: options.sessionServices.activity,
    history: options.sessionServices.history,
    registry: options.projectServices.registry,
    git: options.projectServices.git,
    metadata: options.sessionServices.metadata,
    prompts: options.promptServices.runtime,
    lspOnboarding: options.lspOnboarding,
    dcp,
    updates: options.promptServices.updates,
  });

  return { dcp, coordinator };
}
