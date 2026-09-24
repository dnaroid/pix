import type { SessionNotification } from "@agentclientprotocol/sdk";
import { agentControlStateFromSessionState } from "../lib/agent-control";
import type { SessionStateNotification } from "../lib/session-state";
import type { ActiveSessionState } from "./active-session-state.svelte";
import type { createDcpCompression } from "./dcp-compression.svelte";
import type { createGitWorkspaceStore } from "./git-workspace.svelte";
import type { createPromptRuntime } from "./prompt-runtime.svelte";
import type { createRegistryStore } from "./registry.svelte";
import type { createSessionActivityStore } from "./session-activity.svelte";
import type { createSessionHistory } from "./session-history.svelte";
import type { createSessionMetadataStore } from "./session-metadata.svelte";
import type { createSessionRuntimeStore } from "./session-runtime.svelte";
import type { createSessionUpdateBatcher } from "./session-update-batcher";

type DcpCompression = ReturnType<typeof createDcpCompression>;
type GitWorkspace = ReturnType<typeof createGitWorkspaceStore>;
type PromptRuntime = ReturnType<typeof createPromptRuntime>;
type RegistryStore = ReturnType<typeof createRegistryStore>;
type SessionActivity = ReturnType<typeof createSessionActivityStore>;
type SessionMetadata = ReturnType<typeof createSessionMetadataStore>;
type SessionRuntime = ReturnType<typeof createSessionRuntimeStore>;
type SessionUpdates = ReturnType<typeof createSessionUpdateBatcher>;

type SessionCoordinatorOptions = {
  state: ActiveSessionState;
  closeProjectSelector: () => void;
  closeSessionSelector: () => void;
  clearCommandPicker: () => void;
  cancelAllPendingElicitations: () => void;
  cancelPendingElicitationForSession: (sessionId: string) => void;
  setOperationRunning: (running: boolean) => void;
  runtime: SessionRuntime;
  activity: SessionActivity;
  history: ReturnType<typeof createSessionHistory>;
  registry: RegistryStore;
  git: GitWorkspace;
  metadata: SessionMetadata;
  prompts: PromptRuntime;
  dcp: DcpCompression;
  updates: SessionUpdates;
};

export function createSessionCoordinator(options: SessionCoordinatorOptions) {
  function resetAfterDisconnect(): void {
    options.updates.reset();
    options.history.reset();
    options.closeProjectSelector();
    options.closeSessionSelector();
    options.clearCommandPicker();
    options.cancelAllPendingElicitations();
    options.state.setSessionId(null);
    options.runtime.reset();
    options.state.clearSessionTranscripts();
    options.activity.reset();
    options.registry.reset();
    options.git.setResolveRunning(false);
    options.metadata.reset();
    options.prompts.reset();
    options.dcp.reset();
    options.state.resetContent();
    options.setOperationRunning(false);
  }

  function handleUpdate(notification: SessionNotification): void {
    if (options.metadata.handle(notification)) return;
    options.updates.enqueue(notification);
  }

  function handleState(notification: SessionStateNotification): void {
    if (options.runtime.handleSessionState(notification)) return;
    const agentControlState = agentControlStateFromSessionState(notification);
    if (agentControlState) {
      options.prompts.setAgentState(notification.sessionId, agentControlState);
      return;
    }
    if (options.registry.handleSessionState(notification)) return;
    options.activity.handle(notification);
  }

  function refreshActiveModelUsage(): void {
    const sessionId = options.state.sessionId;
    if (sessionId) void options.runtime.refreshStatus(sessionId, true);
  }

  async function refreshActiveDcpStats(): Promise<void> {
    const sessionId = options.state.sessionId;
    if (sessionId) await options.runtime.refreshDcpStats(sessionId);
  }

  async function refreshActiveSessionUsage(): Promise<void> {
    const sessionId = options.state.sessionId;
    if (sessionId) await options.runtime.refreshSessionUsage(sessionId);
  }

  function clearActivity(sessionId: string): void {
    options.activity.clear(sessionId);
    options.metadata.clear(sessionId);
    options.prompts.clearSession(sessionId);
  }

  function forgetRuntime(sessionId: string): void {
    options.updates.discardSession(sessionId);
    options.history.forget(sessionId);
    options.activity.markForgotten(sessionId);
    options.cancelPendingElicitationForSession(sessionId);
    options.runtime.forget(sessionId);
    options.dcp.clear(sessionId);
  }

  return {
    resetAfterDisconnect,
    handleUpdate,
    handleState,
    refreshActiveModelUsage,
    refreshActiveDcpStats,
    refreshActiveSessionUsage,
    clearActivity,
    resetActivity: options.activity.reset,
    openActivity: options.activity.open,
    beginActivityRequest: options.activity.beginRequest,
    completeActivityRequest: options.activity.completeRequest,
    cancelActivityRequest: options.activity.cancelRequest,
    forgetRuntime,
  };
}
