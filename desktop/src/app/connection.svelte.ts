import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { AcpClient, type QueueState, type QueuedUserMessage } from "../lib/acp-client";
import type { SessionStateNotification } from "../lib/session-state";
import { TauriAcpTransport } from "../lib/tauri-transport";

export type ConnectionStatus = "starting" | "ready" | "error" | "stopped";

type ConnectionStoreOptions = {
  workspace: () => string;
  onSessionUpdate: (notification: SessionNotification) => void;
  onSessionState: (notification: SessionStateNotification) => void;
  onQueueState: (state: QueueState) => void;
  onQueueConsumed: (sessionId: string, message: QueuedUserMessage) => void;
  onElicitation: (request: CreateElicitationRequest) => Promise<CreateElicitationResponse>;
  onDisconnect: () => void;
  openWorkspaceSession: () => Promise<void>;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
};

export function createConnectionStore(options: ConnectionStoreOptions) {
  let client = $state<AcpClient | null>(null);
  let status = $state<ConnectionStatus>("starting");
  let diagnostics = $state<string[]>([]);
  let imagePromptSupported = $state(false);
  let reconnectPromise: Promise<void> | null = null;

  async function connect(): Promise<void> {
    status = "starting";
    options.setErrorMessage(null);
    const transport = new TauriAcpTransport();
    const next = new AcpClient(transport, {
      onSessionUpdate: (notification) => {
        if (client === next) options.onSessionUpdate(notification);
      },
      onSessionState: (notification) => {
        if (client === next) options.onSessionState(notification);
      },
      onQueueState: (state) => {
        if (client === next) options.onQueueState(state);
      },
      onQueueConsumed: (sessionId, message) => {
        if (client === next) options.onQueueConsumed(sessionId, message);
      },
      onElicitation: (request): Promise<CreateElicitationResponse> => client === next
        ? options.onElicitation(request)
        : Promise.resolve({ action: "cancel" }),
      onDiagnostic: (line) => {
        if (client !== next) return;
        diagnostics = [...diagnostics.slice(-49), line];
      },
      onExit: (exit) => {
        if (client !== next) return;
        options.onDisconnect();
        status = exit.requested ? "stopped" : "error";
        if (!exit.requested) {
          options.setErrorMessage(exit.error ?? `pix-acp exited${exit.code === null ? "" : ` with code ${exit.code}`}`);
        }
      },
    });
    client = next;
    try {
      const initialization = await next.start();
      if (client !== next) {
        await next.dispose();
        return;
      }
      imagePromptSupported = initialization.agentCapabilities?.promptCapabilities?.image === true;
      status = "ready";
      if (options.workspace()) await options.openWorkspaceSession();
    } catch (error) {
      if (client !== next) return;
      status = "error";
      options.reportError(error);
    }
  }

  async function reconnect(): Promise<void> {
    if (reconnectPromise) return reconnectPromise;
    reconnectPromise = performReconnect().finally(() => {
      reconnectPromise = null;
    });
    return reconnectPromise;
  }

  async function performReconnect(): Promise<void> {
    const previous = client;
    client = null;
    options.onDisconnect();
    await previous?.dispose().catch(() => {});
    await connect();
  }

  async function dispose(): Promise<void> {
    const current = client;
    client = null;
    await current?.dispose();
  }

  return {
    get client() { return client; },
    get status() { return status; },
    get diagnostics() { return diagnostics; },
    get imagePromptSupported() { return imagePromptSupported; },
    connect,
    reconnect,
    dispose,
  };
}
