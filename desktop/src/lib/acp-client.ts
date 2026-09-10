import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type {
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
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
  type SessionStateNotification,
} from "./session-state";
import type { RegistryActionRequest } from "./registry";
import { isAgentControlState, type AgentControlAction, type AgentControlState } from "./agent-control";

export interface AcpExit {
  readonly generation: number;
  readonly code: number | null;
  readonly success: boolean;
  readonly requested: boolean;
  readonly error: string | null;
}

export interface AcpTransportHandlers {
  readonly onLine: (line: string) => void;
  readonly onStderr: (line: string) => void;
  readonly onExit: (exit: AcpExit) => void;
}

export interface AcpTransport {
  start(handlers: AcpTransportHandlers): Promise<void>;
  send(line: string): Promise<void>;
  stop(): Promise<void>;
}

export interface AcpClientHandlers {
  readonly onSessionUpdate: (notification: SessionNotification) => void;
  readonly onSessionState?: (notification: SessionStateNotification) => void;
  readonly onQueueState?: (state: QueueState) => void;
  readonly onQueueConsumed?: (sessionId: string, message: QueuedUserMessage) => void;
  readonly onElicitation: (request: CreateElicitationRequest) => Promise<CreateElicitationResponse>;
  readonly onDiagnostic?: (message: string) => void;
  readonly onExit?: (exit: AcpExit) => void;
}

export interface AutocompleteSettings {
  readonly enabled: boolean;
  readonly debounceMs: number;
}

export interface ForkMessage {
  readonly entryId: string;
  readonly text: string;
}

export interface ForkSessionResult {
  readonly sessionId: string;
  readonly configOptions: SessionConfigOption[];
  readonly selectedText?: string;
}

export type UserMessageAction = "copy" | "undo";

export interface UserMessageActionResult {
  readonly status: "ok" | "warning" | "cancelled";
  readonly editorText?: string;
  readonly revertedChanges?: number;
  readonly changedFiles?: number;
  readonly warning?: string;
}

export interface LazySessionImage {
  readonly data: string;
  readonly mimeType: string;
}

export interface PromptFileImage {
  readonly uri: string;
  readonly mimeType: string;
  readonly size?: number;
  readonly name?: string;
}

export type QueueSource = "sdk-steering" | "sdk-follow-up" | "auto" | "deferred";
export type QueueAction = "cancel" | "edit" | "send-now";

export interface QueuedImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface QueuedUserMessage {
  readonly id: string;
  readonly promptText: string;
  readonly displayText: string;
  readonly images: readonly QueuedImage[];
}

export interface QueueItem {
  readonly id: string;
  readonly source: QueueSource;
  readonly mode: "steering" | "follow-up";
  readonly index: number;
  readonly text: string;
  readonly message?: QueuedUserMessage;
}

export interface QueueState {
  readonly sessionId: string;
  readonly items: QueueItem[];
}

export interface LazySessionHistory {
  readonly updates: readonly SessionUpdate[];
  readonly deferredToolCallIds: readonly string[];
}

export interface AgentControlStatus {
  readonly sessionId: string;
  readonly state: AgentControlState;
}

type JsonRpcId = string | number;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
  readonly removeAbortListener?: () => void;
}

interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class AcpRequestError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpRequestError";
  }
}

export class AcpClient {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private disposed = false;

  constructor(
    private readonly transport: AcpTransport,
    private readonly handlers: AcpClientHandlers,
  ) {}

  async start(): Promise<InitializeResponse> {
    if (this.disposed) throw new Error("ACP client is disposed");
    await this.transport.start({
      onLine: (line) => this.receiveLine(line),
      onStderr: (line) => this.handlers.onDiagnostic?.(line),
      onExit: (exit) => {
        this.rejectAll(new Error(exit.error ?? `pix-acp exited${exit.code === null ? "" : ` with code ${exit.code}`}`));
        this.handlers.onExit?.(exit);
      },
    });
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

  newSession(cwd: string): Promise<NewSessionResponse> {
    return this.request("session/new", {
      cwd,
      mcpServers: [],
      _meta: { "pix.lazyRuntime": true },
    });
  }

  loadSession(sessionId: string, cwd: string): Promise<LoadSessionResponse> {
    return this.request("session/load", {
      sessionId,
      cwd,
      mcpServers: [],
      _meta: { "pix.lazyHistory": true },
    });
  }

  async sessionHistory(sessionId: string, full = false): Promise<LazySessionHistory> {
    const response = await this.request<unknown>(
      "pix/session/history",
      full ? { sessionId, full: true } : { sessionId },
      null,
    );
    if (!isRecord(response) || !Array.isArray(response.updates) || !Array.isArray(response.deferredToolCallIds)) {
      throw new Error("pix/session/history returned an invalid response");
    }
    const updates: SessionUpdate[] = [];
    for (const update of response.updates) {
      if (!isRecord(update) || typeof update.sessionUpdate !== "string") {
        throw new Error("pix/session/history returned an invalid update");
      }
      updates.push(update as unknown as SessionUpdate);
    }
    const deferredToolCallIds: string[] = [];
    for (const toolCallId of response.deferredToolCallIds) {
      if (typeof toolCallId !== "string") {
        throw new Error("pix/session/history returned an invalid deferred tool id");
      }
      deferredToolCallIds.push(toolCallId);
    }
    return { updates, deferredToolCallIds };
  }

  async toolResult(sessionId: string, toolCallId: string): Promise<SessionUpdate> {
    const response = await this.request<unknown>("pix/session/tool_result", { sessionId, toolCallId }, null);
    if (!isRecord(response) || !isRecord(response.update) || typeof response.update.sessionUpdate !== "string") {
      throw new Error("pix/session/tool_result returned an invalid response");
    }
    return response.update as unknown as SessionUpdate;
  }

  async sessionImage(sessionId: string, imageId: string): Promise<LazySessionImage> {
    const response = await this.request<unknown>("pix/session/image", { sessionId, imageId }, null);
    if (!isRecord(response) || typeof response.data !== "string" || typeof response.mimeType !== "string") {
      throw new Error("pix/session/image returned an invalid response");
    }
    return { data: response.data, mimeType: response.mimeType };
  }

  async forkMessages(sessionId: string): Promise<ForkMessage[]> {
    const response = await this.request<unknown>("pix/session/fork_messages", { sessionId });
    if (!isRecord(response) || !Array.isArray(response.messages)) {
      throw new Error("pix/session/fork_messages returned an invalid response");
    }
    const messages: ForkMessage[] = [];
    for (const message of response.messages) {
      if (!isRecord(message) || typeof message.entryId !== "string" || typeof message.text !== "string") {
        throw new Error("pix/session/fork_messages returned an invalid response");
      }
      messages.push({ entryId: message.entryId, text: message.text });
    }
    return messages;
  }

  async branchUserMessages(sessionId: string): Promise<ForkMessage[]> {
    const response = await this.request<unknown>("pix/session/branch_user_messages", { sessionId }, null);
    if (!isRecord(response) || !Array.isArray(response.messages)) {
      throw new Error("pix/session/branch_user_messages returned an invalid response");
    }
    return response.messages.map((message) => {
      if (!isRecord(message) || typeof message.entryId !== "string" || typeof message.text !== "string") {
        throw new Error("pix/session/branch_user_messages returned an invalid response");
      }
      return { entryId: message.entryId, text: message.text };
    });
  }

  async agentControl(sessionId: string, action: AgentControlAction): Promise<AgentControlStatus> {
    const response = await this.request<unknown>("pix/session/agent_control", { sessionId, action }, null);
    if (
      !isRecord(response)
      || typeof response.sessionId !== "string"
      || !isAgentControlState(response.state)
    ) {
      throw new Error("pix/session/agent_control returned an invalid response");
    }
    return { sessionId: response.sessionId, state: response.state };
  }

  async userMessageAction(
    sessionId: string,
    entryId: string,
    action: UserMessageAction,
  ): Promise<UserMessageActionResult> {
    const response = await this.request<unknown>("pix/session/user_message_action", { sessionId, entryId, action }, null);
    if (
      !isRecord(response)
      || (response.status !== "ok" && response.status !== "warning" && response.status !== "cancelled")
    ) {
      throw new Error("pix/session/user_message_action returned an invalid response");
    }
    return {
      status: response.status,
      ...(typeof response.editorText === "string" ? { editorText: response.editorText } : {}),
      ...(typeof response.revertedChanges === "number" ? { revertedChanges: response.revertedChanges } : {}),
      ...(typeof response.changedFiles === "number" ? { changedFiles: response.changedFiles } : {}),
      ...(typeof response.warning === "string" ? { warning: response.warning } : {}),
    };
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

  async reloadSession(sessionId: string): Promise<{ configOptions: SessionConfigOption[] }> {
    const response = await this.request<unknown>("pix/session/reload", { sessionId }, null);
    if (!isRecord(response)) throw new Error("pix/session/reload returned an invalid response");
    return {
      configOptions: Array.isArray(response.configOptions)
        ? response.configOptions as SessionConfigOption[]
        : [],
    };
  }

  async enhancePrompt(sessionId: string, draft: string): Promise<string> {
    const response = await this.request<unknown>("pix/prompt/enhance", { sessionId, draft }, null);
    if (!isRecord(response) || typeof response.prompt !== "string" || response.prompt.trim().length === 0) {
      throw new Error("pix/prompt/enhance returned an invalid response");
    }
    return response.prompt;
  }

  async gitAssist(sessionId: string, kind: "review" | "commit-message", diff: string): Promise<string> {
    const response = await this.request<unknown>("pix/git/assist", { sessionId, kind, diff }, null);
    if (!isRecord(response) || typeof response.text !== "string" || response.text.trim().length === 0) {
      throw new Error("pix/git/assist returned an invalid response");
    }
    return response.text;
  }

  async importSession(sessionId: string, path: string): Promise<{ configOptions: SessionConfigOption[] }> {
    const response = await this.request<unknown>("pix/session/import", { sessionId, path }, null);
    if (!isRecord(response)) throw new Error("pix/session/import returned an invalid response");
    return {
      configOptions: Array.isArray(response.configOptions)
        ? response.configOptions as SessionConfigOption[]
        : [],
    };
  }

  async requestHistory(sessionId: string): Promise<string[]> {
    const response = await this.request<unknown>("pix/request-history", { sessionId }, null);
    if (!isRecord(response) || !Array.isArray(response.entries) || response.entries.some((entry) => typeof entry !== "string")) {
      throw new Error("pix/request-history returned an invalid response");
    }
    return response.entries as string[];
  }

  async queueState(sessionId: string): Promise<QueueState> {
    return parseQueueState(await this.request<unknown>("pix/session/queue_state", { sessionId }, null));
  }

  async registryAction(sessionId: string, action: RegistryActionRequest): Promise<void> {
    const response = await this.request<unknown>("pix/registry/action", { sessionId, ...action }, null);
    if (!isRecord(response)) throw new Error("pix/registry/action returned an invalid response");
  }

  async queueMessage(
    sessionId: string,
    prompt: readonly ContentBlock[],
    displayText: string,
    fileImages: readonly PromptFileImage[] = [],
  ): Promise<{ disposition: "steering" | "auto"; itemId: string }> {
    const response = await this.request<unknown>("pix/session/queue_message", {
      sessionId,
      prompt,
      displayText,
      ...(fileImages.length > 0 ? { _meta: { "pix.fileImages": fileImages } } : {}),
    }, null);
    if (!isRecord(response) || !["steering", "auto"].includes(String(response.disposition)) || typeof response.itemId !== "string") {
      throw new Error("pix/session/queue_message returned an invalid response");
    }
    return { disposition: response.disposition as "steering" | "auto", itemId: response.itemId };
  }

  async deferMessage(
    sessionId: string,
    prompt: readonly ContentBlock[],
    displayText: string,
    fileImages: readonly PromptFileImage[] = [],
  ): Promise<{ itemId: string }> {
    const response = await this.request<unknown>("pix/session/defer_message", {
      sessionId,
      prompt,
      displayText,
      ...(fileImages.length > 0 ? { _meta: { "pix.fileImages": fileImages } } : {}),
    }, null);
    if (!isRecord(response) || response.disposition !== "deferred" || typeof response.itemId !== "string") {
      throw new Error("pix/session/defer_message returned an invalid response");
    }
    return { itemId: response.itemId };
  }

  async queueAction(sessionId: string, item: QueueItem, action: QueueAction): Promise<{
    message?: QueuedUserMessage;
    interruptRequired: boolean;
  }> {
    const response = await this.request<unknown>("pix/session/queue_action", {
      sessionId,
      source: item.source,
      index: item.index,
      text: item.text,
      action,
    }, null);
    if (!isRecord(response)) throw new Error("pix/session/queue_action returned an invalid response");
    const queued = response.message === undefined ? undefined : parseQueuedUserMessage(response.message);
    if (response.message !== undefined && !queued) throw new Error("pix/session/queue_action returned an invalid message");
    return {
      ...(queued ? { message: queued } : {}),
      interruptRequired: response.interruptRequired === true,
    };
  }

  async takeAutoMessage(sessionId: string): Promise<QueuedUserMessage | undefined> {
    const response = await this.request<unknown>("pix/session/take_auto_message", { sessionId }, null);
    if (!isRecord(response)) throw new Error("pix/session/take_auto_message returned an invalid response");
    if (response.message === undefined) return undefined;
    const queued = parseQueuedUserMessage(response.message);
    if (!queued) throw new Error("pix/session/take_auto_message returned an invalid message");
    return queued;
  }

  async resumeSessionPath(sessionId: string, path: string): Promise<{ configOptions: SessionConfigOption[] }> {
    const response = await this.request<unknown>("pix/session/resume_path", { sessionId, path }, null);
    if (!isRecord(response)) throw new Error("pix/session/resume_path returned an invalid response");
    return {
      configOptions: Array.isArray(response.configOptions)
        ? response.configOptions as SessionConfigOption[]
        : [],
    };
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

  async autocomplete(sessionId: string, draft: string, signal?: AbortSignal): Promise<string> {
    const response = await this.request<unknown>(
      "pix/autocomplete",
      { sessionId, draft },
      DEFAULT_TIMEOUT_MS,
      signal,
    );
    if (!isRecord(response) || typeof response.completion !== "string") {
      throw new Error("pix/autocomplete returned an invalid response");
    }
    return response.completion;
  }

  async autocompleteSettings(sessionId: string): Promise<AutocompleteSettings> {
    const response = await this.request<unknown>("pix/autocomplete/config", { sessionId });
    if (
      !isRecord(response)
      || typeof response.enabled !== "boolean"
      || typeof response.debounceMs !== "number"
      || !Number.isFinite(response.debounceMs)
    ) {
      throw new Error("pix/autocomplete/config returned an invalid response");
    }
    return { enabled: response.enabled, debounceMs: response.debounceMs };
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
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAll(new Error("ACP client disposed"));
    await this.transport.stop();
  }

  private request<Response>(
    method: string,
    params: unknown,
    timeoutMs: number | null = DEFAULT_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (this.disposed) return Promise.reject(new Error("ACP client is disposed"));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const id = this.nextId++;
    let sent: Promise<void> = Promise.resolve();
    let removeAbortListener: (() => void) | undefined;
    const result = new Promise<Response>((resolve, reject) => {
      const timer = timeoutMs === null
        ? undefined
        : setTimeout(() => {
            if (!this.takePending(id)) return;
            reject(new Error(`${method} timed out after ${timeoutMs}ms`));
            this.cancelRemoteRequest(id, sent);
          }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as Response),
        reject,
        ...(timer ? { timer } : {}),
        ...(signal ? { removeAbortListener: () => removeAbortListener?.() } : {}),
      });
    });

    sent = this.send({ jsonrpc: "2.0", id, method, params });
    void sent.catch((error: unknown) => {
      this.rejectPending(id, toError(error));
    });
    if (signal) {
      const onAbort = (): void => {
        const pending = this.takePending(id);
        if (!pending) return;
        pending.reject(abortError(signal));
        this.cancelRemoteRequest(id, sent);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
    }
    return result;
  }

  private cancelRemoteRequest(id: JsonRpcId, sent: Promise<void>): void {
    void sent
      .then(() => this.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: id } }))
      .catch(() => {});
  }

  private notify(method: string, params: unknown): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("ACP client is disposed"));
    return this.send({ jsonrpc: "2.0", method, params });
  }

  private async send(message: Record<string, unknown>): Promise<void> {
    await this.transport.send(JSON.stringify(message));
  }

  private receiveLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handlers.onDiagnostic?.(`ignored malformed ACP JSON: ${toError(error).message}`);
      return;
    }
    if (!isRecord(message)) {
      this.handlers.onDiagnostic?.("ignored non-object ACP message");
      return;
    }
    void this.handleMessage(message).catch((error: unknown) => {
      this.handlers.onDiagnostic?.(`failed to handle ACP message: ${toError(error).message}`);
    });
  }

  private async handleMessage(message: Record<string, unknown>): Promise<void> {
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        await this.handleIncomingRequest(message);
      } else if (message.method === "session/update" && isRecord(message.params)) {
        this.handlers.onSessionUpdate(message.params as SessionNotification);
      } else if (message.method === PIX_SESSION_STATE_METHOD) {
        const notification = parseSessionStateNotification(message.params);
        if (notification) this.handlers.onSessionState?.(notification);
      } else if (message.method === "pix/session/queue_state") {
        try {
          this.handlers.onQueueState?.(parseQueueState(message.params));
        } catch (error) {
          this.handlers.onDiagnostic?.(`ignored invalid queue state: ${toError(error).message}`);
        }
      } else if (message.method === "pix/session/queue_consumed" && isRecord(message.params)) {
        const queued = parseQueuedUserMessage(message.params.message);
        if (typeof message.params.sessionId === "string" && queued) {
          this.handlers.onQueueConsumed?.(message.params.sessionId, queued);
        }
      }
      return;
    }

    if (!isJsonRpcId(message.id)) {
      this.handlers.onDiagnostic?.("ignored ACP response without a valid id");
      return;
    }
    const pending = this.takePending(message.id);
    if (!pending) return;
    if (isJsonRpcError(message.error)) {
      pending.reject(new AcpRequestError(message.error.message, message.error.code, message.error.data));
    } else {
      pending.resolve(message.result);
    }
  }

  private async handleIncomingRequest(message: Record<string, unknown>): Promise<void> {
    if (!isJsonRpcId(message.id)) return;
    if (message.method !== "elicitation/create" || !isRecord(message.params)) {
      await this.sendError(message.id, -32601, `unsupported client method: ${String(message.method)}`);
      return;
    }

    try {
      const response = await this.handlers.onElicitation(message.params as CreateElicitationRequest);
      await this.send({ jsonrpc: "2.0", id: message.id, result: response });
    } catch (error) {
      await this.sendError(message.id, -32603, toError(error).message);
    }
  }

  private sendError(id: JsonRpcId, code: number, message: string): Promise<void> {
    return this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private takePending(id: JsonRpcId): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    return pending;
  }

  private rejectPending(id: JsonRpcId, error: Error): void {
    this.takePending(id)?.reject(error);
  }

  private rejectAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.rejectPending(id, error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseQueueState(value: unknown): QueueState {
  if (!isRecord(value) || typeof value.sessionId !== "string" || !Array.isArray(value.items)) {
    throw new Error("invalid Pix queue state");
  }
  const items: QueueItem[] = [];
  for (const candidate of value.items) {
    if (
      !isRecord(candidate)
      || typeof candidate.id !== "string"
      || !["sdk-steering", "sdk-follow-up", "auto", "deferred"].includes(String(candidate.source))
      || !["steering", "follow-up"].includes(String(candidate.mode))
      || !Number.isSafeInteger(candidate.index)
      || typeof candidate.text !== "string"
    ) throw new Error("invalid Pix queue item");
    const queued = candidate.message === undefined ? undefined : parseQueuedUserMessage(candidate.message);
    if (candidate.message !== undefined && !queued) throw new Error("invalid Pix queued message");
    items.push({
      id: candidate.id,
      source: candidate.source as QueueSource,
      mode: candidate.mode as "steering" | "follow-up",
      index: Number(candidate.index),
      text: candidate.text,
      ...(queued ? { message: queued } : {}),
    });
  }
  return { sessionId: value.sessionId, items };
}

function parseQueuedUserMessage(value: unknown): QueuedUserMessage | undefined {
  if (
    !isRecord(value)
    || typeof value.id !== "string"
    || typeof value.promptText !== "string"
    || typeof value.displayText !== "string"
    || !Array.isArray(value.images)
  ) return undefined;
  const images: QueuedImage[] = [];
  for (const image of value.images) {
    if (!isRecord(image) || image.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string") return undefined;
    images.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  return { id: value.id, promptText: value.promptText, displayText: value.displayText, images };
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isJsonRpcError(value: unknown): value is JsonRpcError {
  return isRecord(value) && typeof value.code === "number" && typeof value.message === "string";
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}
