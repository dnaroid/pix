import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { QueueState, QueuedUserMessage } from "../lib/acp-client";
import type { SessionStateNotification } from "../lib/session-state";
import { createConnectionStore } from "./connection.svelte";

type SessionCoordinatorBridge = {
  handleUpdate: (notification: SessionNotification) => void;
  handleState: (notification: SessionStateNotification) => void;
  resetAfterDisconnect: () => void;
  openActivity: (sessionId: string) => string;
  beginActivityRequest: (owner: string) => void;
  completeActivityRequest: (owner: string, sessionId: string) => void;
  cancelActivityRequest: (owner: string) => void;
};

type PromptRuntimeBridge = {
  handleQueueState: (state: QueueState) => void;
  handleQueueConsumed: (sessionId: string, message: QueuedUserMessage) => void;
};

type WorkspaceSessionStartupBridge = {
  open: () => Promise<void>;
};

type DesktopConnectionServicesOptions = {
  workspace: () => string;
  sessionCoordinator: () => SessionCoordinatorBridge;
  promptRuntime: () => PromptRuntimeBridge;
  workspaceSessionStartup: () => WorkspaceSessionStartupBridge;
  requestElicitation: (request: CreateElicitationRequest) => Promise<CreateElicitationResponse>;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
};

export function createDesktopConnectionServices(options: DesktopConnectionServicesOptions) {
  return createConnectionStore({
    workspace: options.workspace,
    onSessionUpdate: (notification) => options.sessionCoordinator().handleUpdate(notification),
    onSessionState: (notification) => options.sessionCoordinator().handleState(notification),
    onOpenActivity: (sessionId) => options.sessionCoordinator().openActivity(sessionId),
    onBeginActivityRequest: (owner) => options.sessionCoordinator().beginActivityRequest(owner),
    onCompleteActivityRequest: (owner, sessionId) => options.sessionCoordinator().completeActivityRequest(owner, sessionId),
    onCancelActivityRequest: (owner) => options.sessionCoordinator().cancelActivityRequest(owner),
    onQueueState: (state) => options.promptRuntime().handleQueueState(state),
    onQueueConsumed: (sessionId, message) => options.promptRuntime().handleQueueConsumed(sessionId, message),
    onElicitation: options.requestElicitation,
    onDisconnect: () => options.sessionCoordinator().resetAfterDisconnect(),
    openWorkspaceSession: () => options.workspaceSessionStartup().open(),
    setErrorMessage: options.setErrorMessage,
    reportError: options.reportError,
  });
}
