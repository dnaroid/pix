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
  let disposed = false;
  let generation = 0;
  let connectPromise: Promise<void> | null = null;
  let reconnectPromise: Promise<void> | null = null;
  let disposePromise: Promise<void> | null = null;

  function connect(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (reconnectPromise) return reconnectPromise;
    if (connectPromise) return connectPromise;
    if (client) return status === "ready" ? Promise.resolve() : reconnect();
    const pending = performConnect(++generation).finally(() => {
      if (connectPromise === pending) connectPromise = null;
    });
    connectPromise = pending;
    return pending;
  }

  async function performConnect(requestGeneration: number): Promise<void> {
    if (disposed || requestGeneration !== generation) return;
    status = "starting";
    imagePromptSupported = false;
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
        client = null;
        generation += 1;
        imagePromptSupported = false;
        options.onDisconnect();
        status = exit.requested ? "stopped" : "error";
        if (!exit.requested) {
          options.setErrorMessage(exit.error ?? `pix-acp exited${exit.code === null ? "" : ` with code ${exit.code}`}`);
        }
        void next.dispose().catch(() => {});
      },
    });
    client = next;
    try {
      const initialization = await next.start();
      if (disposed || requestGeneration !== generation || client !== next) {
        await next.dispose();
        return;
      }
      imagePromptSupported = initialization.agentCapabilities?.promptCapabilities?.image === true;
      status = "ready";
      if (options.workspace()) await options.openWorkspaceSession();
    } catch (error) {
      if (disposed || requestGeneration !== generation || client !== next) return;
      status = "error";
      options.reportError(error);
    }
  }

  function reconnect(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (reconnectPromise) return reconnectPromise;
    const pending = performReconnect(++generation).finally(() => {
      if (reconnectPromise === pending) reconnectPromise = null;
    });
    reconnectPromise = pending;
    return pending;
  }

  async function performReconnect(requestGeneration: number): Promise<void> {
    const previous = client;
    client = null;
    status = "starting";
    imagePromptSupported = false;
    options.onDisconnect();
    await previous?.dispose().catch(() => {});
    await performConnect(requestGeneration);
  }

  function dispose(): Promise<void> {
    if (disposePromise) return disposePromise;
    disposed = true;
    generation += 1;
    const current = client;
    client = null;
    status = "stopped";
    imagePromptSupported = false;
    disposePromise = Promise.all([
      current?.dispose(),
      connectPromise?.catch(() => {}),
      reconnectPromise?.catch(() => {}),
    ]).then(() => {});
    return disposePromise;
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
