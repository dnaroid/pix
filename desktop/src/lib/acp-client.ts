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
  SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import {
  PIX_SESSION_STATE_METHOD,
  parseSessionStateNotification,
  type SessionStateNotification,
} from "./session-state";

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
    return this.request("session/new", { cwd, mcpServers: [] });
  }

  loadSession(sessionId: string, cwd: string): Promise<LoadSessionResponse> {
    return this.request("session/load", { sessionId, cwd, mcpServers: [] });
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

  closeSession(sessionId: string): Promise<Record<string, never>> {
    return this.request("session/close", { sessionId });
  }

  prompt(sessionId: string, prompt: ContentBlock[]): Promise<PromptResponse> {
    return this.request(
      "session/prompt",
      { sessionId, prompt },
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
