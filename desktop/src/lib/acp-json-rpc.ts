import type { AcpExit, AcpTransport } from "./acp-client-types";

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

export interface AcpJsonRpcHandlers {
  readonly onNotification: (method: string, params: unknown) => void;
  readonly onRequest: (method: string, params: unknown) => Promise<unknown>;
  readonly onDiagnostic?: (message: string) => void;
  readonly onExit?: (exit: AcpExit) => void;
}

export class AcpRequestError extends Error {
  constructor(message: string, readonly code: number, readonly data?: unknown) {
    super(message);
    this.name = "AcpRequestError";
  }
}

export class AcpIncomingRequestError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "AcpIncomingRequestError";
  }
}

export class AcpJsonRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private disposed = false;

  constructor(
    private readonly transport: AcpTransport,
    private readonly handlers: AcpJsonRpcHandlers,
  ) {}

  async start(): Promise<void> {
    if (this.disposed) throw new Error("ACP client is disposed");
    await this.transport.start({
      onLine: (line) => this.receiveLine(line),
      onStderr: (line) => this.handlers.onDiagnostic?.(line),
      onExit: (exit) => {
        this.rejectAll(new Error(exit.error ?? `pix-acp exited${exit.code === null ? "" : ` with code ${exit.code}`}`));
        this.handlers.onExit?.(exit);
      },
    });
  }

  request<Response>(
    method: string,
    params: unknown,
    timeoutMs: number | null = 30_000,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (this.disposed) return Promise.reject(new Error("ACP client is disposed"));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const id = this.nextId++;
    let sent: Promise<void> = Promise.resolve();
    let removeAbortListener: (() => void) | undefined;
    const result = new Promise<Response>((resolve, reject) => {
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
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
    void sent.catch((error: unknown) => this.rejectPending(id, toError(error)));
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

  notify(method: string, params: unknown): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("ACP client is disposed"));
    return this.send({ jsonrpc: "2.0", method, params });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAll(new Error("ACP client disposed"));
    await this.transport.stop();
  }

  private cancelRemoteRequest(id: JsonRpcId, sent: Promise<void>): void {
    void sent
      .then(() => this.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: id } }))
      .catch(() => {});
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
      } else {
        this.handlers.onNotification(message.method, message.params);
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
    if (!isJsonRpcId(message.id) || typeof message.method !== "string") return;
    try {
      const result = await this.handlers.onRequest(message.method, message.params);
      await this.send({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      const requestError = error instanceof AcpIncomingRequestError ? error : undefined;
      await this.sendError(message.id, requestError?.code ?? -32603, toError(error).message);
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
