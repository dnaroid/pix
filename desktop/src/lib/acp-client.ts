import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { PIX_SESSION_CATALOG_CHANGED_METHOD } from "../../../acp/src/acp/session-catalog-contract";
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
import type { BtwCommand, BtwState } from "../../../acp/src/btw/contract";
import {
  PIX_SESSION_STATE_METHOD,
  parseSessionStateNotification,
} from "./session-state";
import type { RegistryActionRequest, RegistryDiff, RegistryResourceType, RegistrySnapshot } from "./registry";
import type { AgentControlAction } from "./agent-control";
import { isRecord, parseQueueState, parseQueuedUserMessage } from "./acp-response-parsers";
import { AcpIncomingRequestError, AcpJsonRpcConnection } from "./acp-json-rpc";
import { AcpPixExtensions } from "./acp-pix-extensions";
import { SEARCH_CONFIG_METHOD, SEARCH_QUERY_METHOD, SEARCH_COMMITS_METHOD, SEARCH_INTENT_METHOD, SEARCH_TASKS_METHOD, type SearchIntentRequest, type SearchIntentResponse, type SearchConfigRequest, type SearchStatus, type SearchQueryRequest, type SearchQueryResponse, type SemanticTasksRequest, type SemanticTasksResponse } from "../../../acp/src/search/contract";
import { SEARCH_RAG_METHOD, SEARCH_RAG_DELTA_METHOD, type RagRequest, type RagResponse, type RagProgress } from "../../../acp/src/search/rag-contract";
import { TASK_TYPE_CLASSIFY_METHOD, isClassifiedTaskType, type TaskTypeClassifyRequest, type TaskTypeClassifyResponse } from "../../../acp/src/tasks/type-classification-contract";
import type { CommitSearchRequest, CommitSearchResponse } from "../../../acp/src/search/contract";
import type {
  AcpClientHandlers,
  AcpTransport,
  AgentControlStatus,
  AutocompleteSettings,
  ClaudeQuotaRefreshStatus,
  DcpStatsStatus,
  DraftSessionConfig,
  ForkMessage,
  ForkSessionResult,
  LazySessionHistory,
  LazySessionImage,
  LspAction,
  LspSnapshot,
  PromptFileImage,
  QueuedUserMessage,
  QueueAction,
  QueueItem,
  QueueState,
  RuntimeStatus,
  SessionUsageStatus,
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
  ClaudeQuotaRefreshStatus,
  ContextUsageStatus,
  DcpStatsStatus,
  DraftSessionConfig,
  ForkMessage,
  ForkSessionResult,
  LazySessionHistory,
  LazySessionImage,
  LspAction,
  LspSnapshot,
  ModelUsageLimitWindow,
  ModelUsageRefresh,
  ModelUsageResetCredit,
  ModelUsageStatus,
  PromptFileImage,
  QueuedImage,
  QueuedUserMessage,
  QueueAction,
  QueueItem,
  QueueSource,
  QueueState,
  RuntimeStatus,
  SessionUsageProvider,
  SessionUsageReport,
  SessionUsageStatus,
  SessionUsageTotals,
  UserMessageAction,
  UserMessageActionResult,
} from "./acp-client-types";

export class AcpClient {
  private readonly rpc: AcpJsonRpcConnection;
  private readonly pix: AcpPixExtensions;
  private readonly ragUpdates = new Map<string, (update: RagProgress) => void>();

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

  async newSession(cwd: string, draftConfig?: DraftSessionConfig): Promise<NewSessionResponse> {
    const owner = this.beginActivityRequest();
    try {
      const response = await this.request<NewSessionResponse>("session/new", {
        cwd,
        mcpServers: [],
        _meta: {
          "pix.lazyRuntime": true,
          ...(owner ? { "pix.activityOwner": owner } : {}),
          ...(draftConfig ? {
            "pix.draftModel": draftConfig.modelRef,
            ...(draftConfig.thinkingLevel ? { "pix.draftThinking": draftConfig.thinkingLevel } : {}),
          } : {}),
        },
      });
      if (owner) this.handlers.onCompleteActivityRequest?.(owner, response.sessionId);
      return response;
    } finally {
      if (owner) this.handlers.onCancelActivityRequest?.(owner);
    }
  }

  private beginActivityRequest(): string | undefined {
    if (!this.handlers.onBeginActivityRequest) return undefined;
    const owner = crypto.randomUUID();
    this.handlers.onBeginActivityRequest(owner);
    return owner;
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
      _meta: {
        "pix.lazyHistory": true,
        ...(this.handlers.onOpenActivity ? { "pix.activityOwner": this.handlers.onOpenActivity(sessionId) } : {}),
      },
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

  btw(sessionId: string, command: BtwCommand): Promise<BtwState> {
    return this.pix.btw(sessionId, command);
  }

  userMessageAction(
    sessionId: string,
    entryId: string,
    action: UserMessageAction,
  ): Promise<UserMessageActionResult> {
    return this.pix.userMessageAction(sessionId, entryId, action);
  }

  async forkSession(sessionId: string, cwd: string, entryId: string): Promise<ForkSessionResult> {
    const owner = this.beginActivityRequest();
    try {
      const response = await this.request<unknown>("session/fork", {
        sessionId,
        cwd,
        mcpServers: [],
        _meta: { "pix.entryId": entryId, ...(owner ? { "pix.activityOwner": owner } : {}) },
      });
      if (!isRecord(response) || typeof response.sessionId !== "string") {
        throw new Error("session/fork returned an invalid response");
      }
      if (owner) this.handlers.onCompleteActivityRequest?.(owner, response.sessionId);
      const configOptions = Array.isArray(response.configOptions)
        ? response.configOptions as SessionConfigOption[]
        : [];
      const meta = isRecord(response._meta) ? response._meta : undefined;
      const selectedText = typeof meta?.["pix.selectedText"] === "string"
        ? meta["pix.selectedText"]
        : undefined;
      return { sessionId: response.sessionId, configOptions, ...(selectedText === undefined ? {} : { selectedText }) };
    } finally {
      if (owner) this.handlers.onCancelActivityRequest?.(owner);
    }
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

  registryAction(cwd: string, action: RegistryActionRequest): Promise<RegistrySnapshot> {
    return this.pix.registryAction(cwd, action);
  }

  registryDiff(cwd: string, type: Exclude<RegistryResourceType, "project">, name: string): Promise<RegistryDiff> {
    return this.pix.registryDiff(cwd, type, name);
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

  forkMessage(
    sessionId: string,
    prompt: readonly ContentBlock[],
    displayText: string,
    fileImages: readonly PromptFileImage[] = [],
  ): Promise<{ itemId: string }> {
    return this.pix.forkMessage(sessionId, prompt, displayText, fileImages);
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

  searchCommits(request: CommitSearchRequest, signal?: AbortSignal): Promise<CommitSearchResponse> {
    return this.request(SEARCH_COMMITS_METHOD, request, null, signal);
  }

  async searchIntent(request: SearchIntentRequest, signal?: AbortSignal): Promise<SearchIntentResponse> {
    const response = await this.request<unknown>(SEARCH_INTENT_METHOD, request, null, signal);
    if (!response || typeof response !== "object" || !("intent" in response) || !("fallback" in response)
      || (response.intent !== "search" && response.intent !== "ask") || typeof response.fallback !== "boolean"
      || (response.fallback && response.intent !== "search")) {
      throw new Error("Invalid search intent response");
    }
    return { intent: response.intent, fallback: response.fallback };
  }

  async classifyTaskType(request: TaskTypeClassifyRequest, signal?: AbortSignal): Promise<TaskTypeClassifyResponse> {
    const response = await this.request<unknown>(TASK_TYPE_CLASSIFY_METHOD, request, null, signal);
    if (!response || typeof response !== "object" || !("type" in response) || !("fallback" in response)
      || !isClassifiedTaskType(response.type) || typeof response.fallback !== "boolean"
      || (response.fallback && response.type !== "feature")) {
      throw new Error("Invalid task classification response");
    }
    return { type: response.type, fallback: response.fallback };
  }

  async searchRag(request: RagRequest, onUpdate: (update: RagProgress) => void, signal?: AbortSignal): Promise<RagResponse> {
    if (this.ragUpdates.has(request.requestId)) throw new Error("Duplicate RAG request");
    this.ragUpdates.set(request.requestId, onUpdate);
    try {
      const response = await this.request<unknown>(SEARCH_RAG_METHOD, request, null, signal);
      if (!isRecord(response) || typeof response.answer !== "string" || typeof response.modelRef !== "string"
        || !Array.isArray(response.sourceIds) || response.sourceIds.some(id => typeof id !== "string")) {
        throw new Error("Invalid RAG response");
      }
      return { answer: response.answer, modelRef: response.modelRef, sourceIds: response.sourceIds as string[] };
    } finally {
      this.ragUpdates.delete(request.requestId);
    }
  }

  searchQuery(request: SearchQueryRequest, signal?: AbortSignal): Promise<SearchQueryResponse> {
    return this.request(SEARCH_QUERY_METHOD, request, null, signal);
  }

  searchSemanticTasks(request: SemanticTasksRequest, signal?: AbortSignal): Promise<SemanticTasksResponse> {
    return this.request(SEARCH_TASKS_METHOD, request, null, signal);
  }

  searchConfig(cwd: string, changes: Omit<SearchConfigRequest, "cwd"> = {}, signal?: AbortSignal): Promise<SearchStatus> {
    return this.request(SEARCH_CONFIG_METHOD, { cwd, ...changes }, undefined, signal);
  }

  sessionUsage(sessionId: string): Promise<SessionUsageStatus> {
    return this.pix.sessionUsage(sessionId);
  }

  claudeQuotaRefresh(sessionId: string): Promise<ClaudeQuotaRefreshStatus> {
    return this.pix.claudeQuotaRefresh(sessionId);
  }

  lspControl(sessionId: string, action: LspAction = "status", id?: string, root?: string): Promise<LspSnapshot> {
    return this.pix.lspControl(sessionId, action, id, root);
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
    this.ragUpdates.clear();
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
    if (method === SEARCH_RAG_DELTA_METHOD && isRecord(params)) {
      const listener = typeof params.requestId === "string" ? this.ragUpdates.get(params.requestId) : undefined;
      if (!listener) return;
      if (typeof params.text === "string" && params.text.length <= 1500) listener({ text: params.text });
      else if (Array.isArray(params.sourceIds) && params.sourceIds.length <= 12
        && params.sourceIds.every(id => typeof id === "string" && id.length <= 512)) listener({ sourceIds: params.sourceIds as string[] });
    } else if (method === "session/update" && isRecord(params)) {
      this.handlers.onSessionUpdate(params as SessionNotification);
    } else if (method === PIX_SESSION_CATALOG_CHANGED_METHOD && isRecord(params)) {
      if (typeof params.cwd === "string" && params.cwd.length > 0) {
        this.handlers.onSessionCatalogChanged?.(params.cwd);
      }
    } else if (method === PIX_SESSION_STATE_METHOD) {
      const notification = parseSessionStateNotification(params);
      if (notification) this.handlers.onSessionState?.(notification);
    } else if (method === "pix/session/queue_state") {
      try {
        this.handlers.onQueueState?.(parseQueueState(params));
      } catch (error) {
        this.handlers.onDiagnostic?.(`ignored invalid queue state: ${toError(error).message}`);
      }
    } else if (method === "pix/session/fork_ready" && isRecord(params)) {
      if (typeof params.sourceSessionId === "string" && typeof params.sessionId === "string"
        && typeof params.cwd === "string" && params.sessionId !== params.sourceSessionId) {
        this.handlers.onForkReady?.({ sourceSessionId: params.sourceSessionId, sessionId: params.sessionId, cwd: params.cwd });
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
