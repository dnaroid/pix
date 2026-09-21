import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type {
  ContentBlock,
  CreateElicitationRequest,
  InitializeResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  NewSessionResponse,
  PromptResponse,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
  SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import {
  PIX_SESSION_STATE_METHOD,
  parseSessionStateNotification,
} from "./session-state";
import type { RegistryActionRequest } from "./registry";
import type { AgentControlAction } from "./agent-control";
import { isRecord, parseQueueState, parseQueuedUserMessage } from "./acp-response-parsers";
import { AcpIncomingRequestError, AcpJsonRpcConnection } from "./acp-json-rpc";
import { AcpPixExtensions } from "./acp-pix-extensions";
import type {
  AcpClientHandlers,
  AcpTransport,
  AgentControlStatus,
  AutocompleteSettings,
  DcpStatsStatus,
  DraftSessionConfig,
  ForkMessage,
  ForkSessionResult,
  LazySessionHistory,
  LazySessionImage,
  PromptFileImage,
  QueuedUserMessage,
  QueueAction,
  QueueItem,
  QueueState,
  RuntimeStatus,
  UserMessageAction,
  UserMessageActionResult,
} from "./acp-client-types";

export { AcpRequestError } from "./acp-json-rpc";

export type {
  AcpClientHandlers,
  AcpExit,
  AcpTransport,
  AcpTransportHandlers,
  AgentControlStatus,
  AutocompleteSettings,
  ContextUsageStatus,
  DcpStatsStatus,
  DraftSessionConfig,
  ForkMessage,
  ForkSessionResult,
  LazySessionHistory,
  LazySessionImage,
  ModelUsageLimitWindow,
  ModelUsageRefresh,
  ModelUsageStatus,
  PromptFileImage,
  QueuedImage,
  QueuedUserMessage,
  QueueAction,
  QueueItem,
  QueueSource,
  QueueState,
  RuntimeStatus,
  UserMessageAction,
  UserMessageActionResult,
} from "./acp-client-types";

export class AcpClient {
  private readonly rpc: AcpJsonRpcConnection;
  private readonly pix: AcpPixExtensions;

  constructor(
    transport: AcpTransport,
    private readonly handlers: AcpClientHandlers,
  ) {
    this.rpc = new AcpJsonRpcConnection(transport, {
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (method, params) => this.handleIncomingRequest(method, params),
      onDiagnostic: (message) => this.handlers.onDiagnostic?.(message),
      onExit: (exit) => this.handlers.onExit?.(exit),
    });
    this.pix = new AcpPixExtensions((method, params, timeoutMs, signal) => (
      this.request(method, params, timeoutMs, signal)
    ));
  }

  async start(): Promise<InitializeResponse> {
    await this.rpc.start();
    return this.request<InitializeResponse>("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        elicitation: { form: {} },
        session: { configOptions: { boolean: {} } },
      },
      clientInfo: { name: "pix-desktop", version: "0.1.0" },
    });
  }

  listSessions(cwd: string): Promise<ListSessionsResponse> {
    return this.request("session/list", { cwd });
  }

  newSession(cwd: string, draftConfig?: DraftSessionConfig): Promise<NewSessionResponse> {
    return this.request("session/new", {
      cwd,
      mcpServers: [],
      _meta: {
        "pix.lazyRuntime": true,
        ...(draftConfig ? {
          "pix.draftModel": draftConfig.modelRef,
          "pix.draftThinking": draftConfig.thinkingLevel,
        } : {}),
      },
    });
  }

  draftConfig(cwd: string, selection?: DraftSessionConfig, refreshModelUsage = false) {
    return this.pix.draftConfig(cwd, selection, refreshModelUsage);
  }

  routeModel(cwd: string, prompt: string, attachmentCount: number, signal?: AbortSignal) {
    return this.pix.routeModel(cwd, prompt, attachmentCount, signal);
  }

  modelRoutingStatus(cwd: string) {
    return this.pix.modelRoutingStatus(cwd);
  }

  loadSession(sessionId: string, cwd: string): Promise<LoadSessionResponse> {
    return this.request("session/load", {
      sessionId,
      cwd,
      mcpServers: [],
      _meta: { "pix.lazyHistory": true },
    });
  }

  sessionHistory(sessionId: string, full = false, cursor?: string): Promise<LazySessionHistory> {
    return this.pix.sessionHistory(sessionId, full, cursor);
  }

  toolResult(sessionId: string, toolCallId: string): Promise<SessionUpdate> {
    return this.pix.toolResult(sessionId, toolCallId);
  }

  sessionImage(sessionId: string, imageId: string): Promise<LazySessionImage> {
    return this.pix.sessionImage(sessionId, imageId);
  }

  forkMessages(sessionId: string): Promise<ForkMessage[]> {
    return this.pix.forkMessages(sessionId);
  }

  branchUserMessages(sessionId: string): Promise<ForkMessage[]> {
    return this.pix.branchUserMessages(sessionId);
  }

  agentControl(sessionId: string, action: AgentControlAction): Promise<AgentControlStatus> {
    return this.pix.agentControl(sessionId, action);
  }

  runtimeStatus(sessionId: string, refreshModelUsage = false): Promise<RuntimeStatus> {
    return this.pix.runtimeStatus(sessionId, refreshModelUsage);
  }

  dcpStats(sessionId: string): Promise<DcpStatsStatus> {
    return this.pix.dcpStats(sessionId);
  }

  bash(sessionId: string, command: string, excludeFromContext: boolean, displayText: string): Promise<void> {
    return this.pix.bash(sessionId, command, excludeFromContext, displayText);
  }

  clearTodos(sessionId: string): Promise<void> {
    return this.pix.clearTodos(sessionId);
  }

  userMessageAction(
    sessionId: string,
    entryId: string,
    action: UserMessageAction,
  ): Promise<UserMessageActionResult> {
    return this.pix.userMessageAction(sessionId, entryId, action);
  }

  async forkSession(sessionId: string, cwd: string, entryId: string): Promise<ForkSessionResult> {
    const response = await this.request<unknown>("session/fork", {
      sessionId,
      cwd,
      mcpServers: [],
      _meta: { "pix.entryId": entryId },
    });
    if (!isRecord(response) || typeof response.sessionId !== "string") {
      throw new Error("session/fork returned an invalid response");
    }
    const configOptions = Array.isArray(response.configOptions)
      ? response.configOptions as SessionConfigOption[]
      : [];
    const meta = isRecord(response._meta) ? response._meta : undefined;
    const selectedText = typeof meta?.["pix.selectedText"] === "string"
      ? meta["pix.selectedText"]
      : undefined;
    return { sessionId: response.sessionId, configOptions, ...(selectedText === undefined ? {} : { selectedText }) };
  }

  reloadSession(sessionId: string): Promise<{ configOptions: SessionConfigOption[] }> {
    return this.pix.reloadSession(sessionId);
  }

  enhancePrompt(sessionId: string, draft: string): Promise<string> {
    return this.pix.enhancePrompt(sessionId, draft);
  }

  gitAssist(cwd: string, kind: "review" | "commit-message", diff: string): Promise<string> {
    return this.pix.gitAssist(cwd, kind, diff);
  }

  importSession(sessionId: string, path: string): Promise<{ configOptions: SessionConfigOption[] }> {
    return this.pix.importSession(sessionId, path);
  }

  requestHistory(sessionId: string): Promise<string[]> {
    return this.pix.requestHistory(sessionId);
  }

  queueState(sessionId: string): Promise<QueueState> {
    return this.pix.queueState(sessionId);
  }

  registryAction(sessionId: string, action: RegistryActionRequest): Promise<void> {
    return this.pix.registryAction(sessionId, action);
  }

  queueMessage(
    sessionId: string,
    prompt: readonly ContentBlock[],
    displayText: string,
    fileImages: readonly PromptFileImage[] = [],
  ): Promise<{ disposition: "steering" | "auto"; itemId: string }> {
    return this.pix.queueMessage(sessionId, prompt, displayText, fileImages);
  }

  deferMessage(
    sessionId: string,
    prompt: readonly ContentBlock[],
    displayText: string,
    fileImages: readonly PromptFileImage[] = [],
  ): Promise<{ itemId: string }> {
    return this.pix.deferMessage(sessionId, prompt, displayText, fileImages);
  }

  queueAction(sessionId: string, item: QueueItem, action: QueueAction): Promise<{
    message?: QueuedUserMessage;
    interruptRequired: boolean;
  }> {
    return this.pix.queueAction(sessionId, item, action);
  }

  takeAutoMessage(sessionId: string): Promise<QueuedUserMessage | undefined> {
    return this.pix.takeAutoMessage(sessionId);
  }

  resumeSessionPath(sessionId: string, path: string): Promise<{ configOptions: SessionConfigOption[] }> {
    return this.pix.resumeSessionPath(sessionId, path);
  }

  deleteSession(sessionId: string): Promise<Record<string, never>> {
    return this.request("session/delete", { sessionId });
  }

  closeSession(sessionId: string): Promise<Record<string, never>> {
    return this.request("session/close", { sessionId });
  }

  prompt(
    sessionId: string,
    prompt: ContentBlock[],
    fileImages: readonly PromptFileImage[] = [],
  ): Promise<PromptResponse> {
    return this.request(
      "session/prompt",
      {
        sessionId,
        prompt,
        ...(fileImages.length > 0 ? { _meta: { "pix.fileImages": fileImages } } : {}),
      },
      null,
    );
  }

  autocomplete(sessionId: string, draft: string, signal?: AbortSignal): Promise<string> {
    return this.pix.autocomplete(sessionId, draft, signal);
  }

  autocompleteSettings(sessionId: string): Promise<AutocompleteSettings> {
    return this.pix.autocompleteSettings(sessionId);
  }

  cancel(sessionId: string): Promise<void> {
    return this.notify("session/cancel", { sessionId });
  }

  setConfigOption(
    sessionId: string,
    option: SessionConfigOption,
    value: string | boolean,
  ): Promise<SetSessionConfigOptionResponse> {
    const params = option.type === "boolean"
      ? { sessionId, configId: option.id, type: "boolean" as const, value: Boolean(value) }
      : { sessionId, configId: option.id, value: String(value) };
    return this.request("session/set_config_option", params);
  }

  async dispose(): Promise<void> {
    await this.rpc.dispose();
  }

  private request<Response>(
    method: string,
    params: unknown,
    timeoutMs: number | null = 30_000,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.rpc.request(method, params, timeoutMs, signal);
  }

  private notify(method: string, params: unknown): Promise<void> {
    return this.rpc.notify(method, params);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "session/update" && isRecord(params)) {
      this.handlers.onSessionUpdate(params as SessionNotification);
    } else if (method === PIX_SESSION_STATE_METHOD) {
      const notification = parseSessionStateNotification(params);
      if (notification) this.handlers.onSessionState?.(notification);
    } else if (method === "pix/session/queue_state") {
      try {
        this.handlers.onQueueState?.(parseQueueState(params));
      } catch (error) {
        this.handlers.onDiagnostic?.(`ignored invalid queue state: ${toError(error).message}`);
      }
    } else if (method === "pix/session/queue_consumed" && isRecord(params)) {
      const queued = parseQueuedUserMessage(params.message);
      if (typeof params.sessionId === "string" && queued) {
        this.handlers.onQueueConsumed?.(params.sessionId, queued);
      }
    }
  }

  private async handleIncomingRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== "elicitation/create" || !isRecord(params)) {
      throw new AcpIncomingRequestError(-32601, `unsupported client method: ${method}`);
    }
    return this.handlers.onElicitation(params as CreateElicitationRequest);
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
