import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { invoke } from "@tauri-apps/api/core";
import { AcpClient, type QueueState, type QueuedUserMessage } from "../lib/acp-client";
import { acpCrashReport, cleanAcpDiagnostic } from "../lib/acp-crash-diagnostics";
import type { SessionStateNotification } from "../lib/session-state";
import type { AcpExit, ForkReadyNotification } from "../lib/acp-client-types";
import { TauriAcpTransport } from "../lib/tauri-transport";
import { emitUsageStatsChanged } from "../lib/usage-stats-events";
import type { DesktopDiagnosticEvent } from "../lib/diagnostic-logging";
import type { TaskRunRequest, TaskRunResult } from "../../../acp/src/acp/task-run-contract";

export type ConnectionStatus = "starting" | "ready" | "error" | "stopped";

type ConnectionStoreOptions = {
  onTaskRun?: (request: TaskRunRequest, signal: AbortSignal) => Promise<TaskRunResult>;
  workspace: () => string;
  onSessionUpdate: (notification: SessionNotification) => void;
  onSessionCatalogChanged?: (cwd: string) => void;
  onSessionState: (notification: SessionStateNotification) => void;
  onOpenActivity?: (sessionId: string) => string;
  onBeginActivityRequest?: (owner: string) => void;
  onCompleteActivityRequest?: (owner: string, sessionId: string) => void;
  onCancelActivityRequest?: (owner: string) => void;
  onQueueState: (state: QueueState) => void;
  onQueueConsumed: (sessionId: string, message: QueuedUserMessage) => void;
  onForkReady?: (notification: ForkReadyNotification) => void;
  onElicitation: (request: CreateElicitationRequest) => Promise<CreateElicitationResponse>;
  onDisconnect: () => void;
  openWorkspaceSession: () => Promise<void>;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
  recordDiagnostic?: (event: DesktopDiagnosticEvent) => void;
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
  function record(event: DesktopDiagnosticEvent): void {
    try { options.recordDiagnostic?.(event); }
    catch { /* Logging must not affect connection ownership. */ }
  }

  function reportCrash(exit: AcpExit, requestGeneration: number): void {
    const workspace = options.workspace();
    const report = acpCrashReport(exit, diagnostics);
    options.setErrorMessage(report.message);
    if (!workspace) return;
    // Persist even if reconnect follows immediately. Only the original failure
    // may update the banner; stale completion must not touch the new session.
    void invoke<string>("save_acp_crash_log", { workspace, content: report.content }).then(
      (path) => {
        if (!disposed && generation === requestGeneration && status === "error" && options.workspace() === workspace) {
          options.setErrorMessage(`${report.message} · Log: ${path}`);
        }
      },
      (error) => {
        if (!disposed && generation === requestGeneration && status === "error" && options.workspace() === workspace) {
          options.setErrorMessage(`${report.message} · Could not save crash log: ${cleanAcpDiagnostic(String(error)).slice(0, 200)}`);
        }
      },
    );
  }

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
    record("acp:connecting");
    diagnostics = [];
    imagePromptSupported = false;
    options.setErrorMessage(null);
    const transport = new TauriAcpTransport();
    const next: AcpClient = new AcpClient(transport, {
      onTaskRun: async (request, signal) => {
        if (client !== next || !options.onTaskRun) throw new Error("Task launch connection is unavailable");
        return options.onTaskRun(request, signal);
      },
      onSessionUpdate: (notification) => {
        if (client === next) options.onSessionUpdate(notification);
      },
      onSessionCatalogChanged: (cwd) => {
        if (client === next && cwd === options.workspace()) options.onSessionCatalogChanged?.(cwd);
      },
      onSessionState: (notification) => {
        if (client === next) options.onSessionState(notification);
      },
      onOpenActivity: (sessionId): string => client === next ? options.onOpenActivity?.(sessionId) ?? "" : "",
      onBeginActivityRequest: (owner) => { if (client === next) options.onBeginActivityRequest?.(owner); },
      onCompleteActivityRequest: (owner, sessionId) => { if (client === next) options.onCompleteActivityRequest?.(owner, sessionId); },
      onCancelActivityRequest: (owner) => { if (client === next) options.onCancelActivityRequest?.(owner); },
      onQueueState: (state) => {
        if (client === next) options.onQueueState(state);
      },
      onQueueConsumed: (sessionId, message) => {
        if (client === next) options.onQueueConsumed(sessionId, message);
      },
      onForkReady: (notification) => {
        if (client === next) options.onForkReady?.(notification);
      },
      onUsageStatsChanged: (notification) => {
        if (client === next) emitUsageStatsChanged(notification);
      },
      onElicitation: (request): Promise<CreateElicitationResponse> => client === next
        ? options.onElicitation(request)
        : Promise.resolve({ action: "cancel" }),
      onDiagnostic: (line) => {
        if (client !== next) return;
        diagnostics = [...diagnostics.slice(-49), cleanAcpDiagnostic(line)];
      },
      onExit: (exit) => {
        if (client !== next) return;
        client = null;
        generation += 1;
        imagePromptSupported = false;
        options.onDisconnect();
        status = exit.requested ? "stopped" : "error";
        record(exit.requested ? "acp:stopped" : "acp:unexpected-exit");
        if (!exit.requested) {
          reportCrash(exit, generation);
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
      if (!disposed && generation === requestGeneration && client === next) record("acp:ready");
    } catch (error) {
      if (disposed || requestGeneration !== generation || client !== next) return;
      status = "error";
      record("acp:connect-failed");
      options.reportError(error);
      reportCrash({ generation: requestGeneration, code: null, success: false, requested: false,
        error: error instanceof Error ? error.message : String(error) }, requestGeneration);
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
    record("acp:reconnecting");
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
    if (current) record("acp:stopped");
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
