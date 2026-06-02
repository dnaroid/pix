import path from "node:path";
import fs from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { MessageConnection } from "vscode-jsonrpc";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import {
  DefinitionRequest,
  DiagnosticRefreshRequest,
  DidChangeConfigurationNotification,
  DidChangeTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DidSaveTextDocumentNotification,
  DocumentDiagnosticRequest,
  DocumentSymbolRequest,
  ExecuteCommandRequest,
  HoverRequest,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
  ReferencesRequest,
  type Diagnostic,
  type DocumentDiagnosticReport,
  type InitializeResult,
  type ServerCapabilities,
} from "vscode-languageserver-protocol";
import { withTimeout } from "./async";
import { bestEffortWriteJsonRpc, isChildRunning, killChild, terminateChild } from "./child-process";
import { DEFAULT_STARTUP_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "./constants";
import { DocumentStore } from "./documents";
import type { DiagnosticsStore } from "./diagnostics-store";
import { filePathToUri, uriToFilePath } from "./_shared/paths";
import { isExecutableAvailable } from "./_shared/runner";
import type { LspServerConfig, ResolvedCommand } from "./_shared/types";
import { supportsSave } from "./lsp-utils";
import type { OpenDocument } from "./types";

interface MarkdownToken {
  type: string;
  markup: string;
  content: string;
  map: number[] | null;
  children: MarkdownToken[] | null;
}

function markdownTextToken(content: string): MarkdownToken {
  return { type: "text", markup: "", content, map: null, children: null };
}

function parseMarkdownTokens(text: string): MarkdownToken[] {
  const tokens: MarkdownToken[] = [];
  const lines = text.split(/\r?\n/);
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber];
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const [, markup, content] = heading;
    tokens.push({ type: "heading_open", markup, content: "", map: [lineNumber, lineNumber + 1], children: null });
    tokens.push({ type: "inline", markup: "", content, map: [lineNumber, lineNumber + 1], children: [markdownTextToken(content.trim())] });
    tokens.push({ type: "heading_close", markup, content: "", map: null, children: null });
  }
  return tokens;
}
import { tsserverDiagnosticToLsp, tsserverDiagnosticsFromResponse } from "./tsserver";

export class LspClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private connection: MessageConnection | undefined;
  private capabilities: ServerCapabilities | undefined;
  private readonly documents = new DocumentStore();
  private startPromise: Promise<void> | undefined;
  private initialized = false;
  private unavailableReason: string | undefined;
  private stderrTail = "";
  private readonly dynamicDiagnosticProviders = new Map<string, string | undefined>();
  private diagnosticProviderWaiters: Array<() => void> = [];

  constructor(
    private readonly server: LspServerConfig,
    private readonly root: string,
    private readonly command: ResolvedCommand,
    private readonly diagnostics: DiagnosticsStore,
  ) {}

  get isUnavailable(): boolean {
    return !!this.unavailableReason;
  }

  get reason(): string | undefined {
    return this.unavailableReason;
  }

  async ensureStarted(signal?: AbortSignal): Promise<void> {
    if (this.initialized && this.connection && !this.unavailableReason) return;
    if (this.unavailableReason) throw new Error(this.unavailableReason);
    this.startPromise ??= this.start(signal).catch(async (error) => {
      this.startPromise = undefined;
      await this.shutdown();
      throw error;
    });
    await this.startPromise;
  }

  private async start(signal?: AbortSignal): Promise<void> {
    if (!isExecutableAvailable(this.command.bin)) {
      this.unavailableReason = `${this.server.id}: LSP binary not found: ${this.command.bin}`;
      throw new Error(this.unavailableReason);
    }

    const child = spawn(this.command.bin, this.command.args, {
      cwd: this.command.cwd,
      env: this.command.env ? { ...process.env, ...this.command.env } : process.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process = child;
    let failStartup: ((error: Error) => void) | undefined;
    const startupFailure = new Promise<never>((_resolve, reject) => {
      failStartup = reject;
    });
    const markUnavailable = (reason: string) => {
      this.unavailableReason = reason;
      this.initialized = false;
      this.startPromise = undefined;
      this.connection?.dispose();
      this.connection = undefined;
      failStartup?.(new Error(reason));
    };

    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-4000);
    });
    child.on("error", (error) => {
      markUnavailable(`${this.server.id}: LSP failed to start: ${error.message}`);
    });
    child.on("exit", (code, sig) => {
      markUnavailable(`${this.server.id}: LSP exited (${code ?? sig ?? "unknown"})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`);
    });

    const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    this.connection = connection;
    this.registerHandlers(connection);
    connection.listen();

    const initializeResult = (await withTimeout(
      Promise.race([connection.sendRequest(InitializeRequest.method, this.initializeParams()), startupFailure]),
      this.server.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      `${this.server.id} initialize`,
      signal,
    )) as InitializeResult;
    this.capabilities = initializeResult.capabilities;
    failStartup = undefined;

    await connection.sendNotification(InitializedNotification.method, {});
    if (this.server.settings !== undefined) {
      await connection.sendNotification(DidChangeConfigurationNotification.method, { settings: this.server.settings });
    }

    if (signal?.aborted) throw new Error("aborted");
    this.initialized = true;
  }

  private initializeParams() {
    const rootUri = filePathToUri(this.root);
    return {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ name: path.basename(this.root), uri: rootUri }],
      capabilities: {
        window: { workDoneProgress: true },
        workspace: {
          configuration: true,
          diagnostics: { refreshSupport: true },
          workspaceFolders: true,
          didChangeWatchedFiles: { dynamicRegistration: true },
        },
        textDocument: {
          diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
          synchronization: {
            didOpen: true,
            didChange: true,
            didSave: true,
          },
          publishDiagnostics: {
            relatedInformation: true,
            versionSupport: true,
          },
          hover: {},
          definition: {},
          references: {},
          documentSymbol: {},
        },
      },
      initializationOptions: this.server.initializationOptions ?? {},
    };
  }

  private registerHandlers(connection: MessageConnection): void {
    connection.onNotification(
      PublishDiagnosticsNotification.method,
      (params: { uri: string; diagnostics: Diagnostic[]; version?: number }) => {
        this.diagnostics.set(this.server.id, this.root, params.uri, params.diagnostics, params.version);
      },
    );

    const anyConnection = connection as unknown as {
      onRequest(method: string, handler: (params: unknown) => unknown): void;
      onNotification(method: string, handler: (params: unknown) => void): void;
    };

    anyConnection.onRequest("workspace/configuration", (params: unknown) => {
      const items = (params as { items?: unknown[] } | undefined)?.items;
      if (!Array.isArray(items)) return [this.server.settings ?? {}];
      return items.map(() => this.server.settings ?? {});
    });
    anyConnection.onRequest("workspace/workspaceFolders", () => [{ name: path.basename(this.root), uri: filePathToUri(this.root) }]);
    anyConnection.onRequest("markdown/parse", async (params: unknown) => {
      const request = params as { uri?: unknown; text?: unknown } | undefined;
      const text = typeof request?.text === "string"
        ? request.text
        : typeof request?.uri === "string"
          ? this.documents.get(uriToFilePath(request.uri))?.text ?? await fs.readFile(uriToFilePath(request.uri), "utf8")
          : "";
      return parseMarkdownTokens(text);
    });
    anyConnection.onRequest("markdown/fs/readFile", async (params: unknown) => {
      const uri = (params as { uri?: unknown } | undefined)?.uri;
      if (typeof uri !== "string") return [];
      return [...await fs.readFile(uriToFilePath(uri))];
    });
    anyConnection.onRequest("markdown/fs/stat", async (params: unknown) => {
      const uri = (params as { uri?: unknown } | undefined)?.uri;
      if (typeof uri !== "string") return undefined;
      try {
        const stat = await fs.stat(uriToFilePath(uri));
        return { isDirectory: stat.isDirectory() };
      } catch {
        return undefined;
      }
    });
    anyConnection.onRequest("markdown/fs/readDirectory", async (params: unknown) => {
      const uri = (params as { uri?: unknown } | undefined)?.uri;
      if (typeof uri !== "string") return [];
      try {
        const entries = await fs.readdir(uriToFilePath(uri), { withFileTypes: true });
        return entries.map((entry) => [entry.name, { isDirectory: entry.isDirectory() }]);
      } catch {
        return [];
      }
    });
    anyConnection.onRequest("markdown/fs/watcher/create", () => null);
    anyConnection.onRequest("markdown/fs/watcher/delete", () => null);
    anyConnection.onRequest("markdown/findMarkdownFilesInWorkspace", () => []);
    anyConnection.onRequest("client/registerCapability", (params: unknown) => {
      const registrations = (params as { registrations?: unknown[] } | undefined)?.registrations;
      if (!Array.isArray(registrations)) return null;

      for (const registration of registrations) {
        const item = registration as { id?: unknown; method?: unknown; registerOptions?: unknown };
        if (typeof item.id !== "string" || item.method !== DocumentDiagnosticRequest.method) continue;
        const options = item.registerOptions as { identifier?: unknown } | undefined;
        this.dynamicDiagnosticProviders.set(item.id, typeof options?.identifier === "string" ? options.identifier : undefined);
      }
      this.resolveDiagnosticProviderWaiters();
      return null;
    });
    anyConnection.onRequest("client/unregisterCapability", (params: unknown) => {
      const unregisterations = (params as { unregisterations?: unknown[] } | undefined)?.unregisterations;
      if (!Array.isArray(unregisterations)) return null;

      for (const registration of unregisterations) {
        const item = registration as { id?: unknown; method?: unknown };
        if (typeof item.id === "string" && item.method === DocumentDiagnosticRequest.method) this.dynamicDiagnosticProviders.delete(item.id);
      }
      return null;
    });
    anyConnection.onRequest(DiagnosticRefreshRequest.method, () => null);
    anyConnection.onRequest("window/workDoneProgress/create", () => null);
    anyConnection.onNotification("window/logMessage", () => undefined);
    anyConnection.onNotification("telemetry/event", () => undefined);
  }

  async openOrChange(file: string, languageId: string, text: string, signal?: AbortSignal): Promise<OpenDocument> {
    await this.ensureStarted(signal);
    if (!this.connection) throw new Error(`${this.server.id}: LSP connection unavailable`);

    const existing = this.documents.get(file);
    if (!existing) {
      const doc = this.documents.open(file, languageId, text);
      await this.connection.sendNotification(DidOpenTextDocumentNotification.method, {
        textDocument: {
          uri: doc.uri,
          languageId: doc.languageId,
          version: doc.version,
          text: doc.text,
        },
      });
      return doc;
    }

    const doc = this.documents.change(file, text);
    await this.connection.sendNotification(DidChangeTextDocumentNotification.method, {
      textDocument: { uri: doc.uri, version: doc.version },
      contentChanges: [{ text: doc.text }],
    });
    return doc;
  }

  async didSave(file: string): Promise<void> {
    if (!this.connection || !supportsSave(this.capabilities)) return;
    const doc = this.documents.get(file);
    if (!doc) return;
    await this.connection.sendNotification(DidSaveTextDocumentNotification.method, {
      textDocument: { uri: doc.uri },
      text: doc.text,
    });
  }

  private supportsTsserverDiagnostics(): boolean {
    const commands = this.capabilities?.executeCommandProvider?.commands;
    return Array.isArray(commands) && commands.includes("typescript.tsserverRequest");
  }

  private supportsPullDiagnostics(): boolean {
    return !!this.capabilities?.diagnosticProvider || this.dynamicDiagnosticProviders.size > 0;
  }

  private resolveDiagnosticProviderWaiters(): void {
    const waiters = this.diagnosticProviderWaiters;
    this.diagnosticProviderWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private async waitForPullDiagnosticsSupport(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.supportsPullDiagnostics() || timeoutMs <= 0) return;
    await withTimeout(new Promise<void>((resolve) => {
      this.diagnosticProviderWaiters.push(resolve);
    }), timeoutMs, `${this.server.id} diagnostic registration`, signal).catch(() => undefined);
  }

  private diagnosticProviderIdentifiers(): Array<string | undefined> {
    const identifiers: Array<string | undefined> = [];
    const provider = this.capabilities?.diagnosticProvider;
    if (provider) {
      identifiers.push(
        typeof provider === "object" && "identifier" in provider && typeof provider.identifier === "string"
          ? provider.identifier
          : undefined,
      );
    }
    for (const identifier of this.dynamicDiagnosticProviders.values()) identifiers.push(identifier);

    const seen = new Set<string>();
    return identifiers.filter((identifier) => {
      const key = identifier ?? "";
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private diagnosticsFromReport(report: DocumentDiagnosticReport | null | undefined): Diagnostic[] | undefined {
    if (!report || report.kind !== "full") return undefined;
    return report.items;
  }

  async tsserverDiagnostics(file: string, text: string, timeoutMs: number, signal?: AbortSignal): Promise<Diagnostic[] | undefined> {
    const connection = this.connection;
    if (!connection || !this.supportsTsserverDiagnostics()) return undefined;

    const requests = [
      { command: "syntacticDiagnosticsSync", executionTarget: 1 },
      { command: "semanticDiagnosticsSync", executionTarget: 0 },
      { command: "suggestionDiagnosticsSync", executionTarget: 0 },
    ];

    const responses = await Promise.all(requests.map((request) => withTimeout(
      connection.sendRequest(ExecuteCommandRequest.method, {
        command: "typescript.tsserverRequest",
        arguments: [
          request.command,
          { file, includeLinePosition: true },
          {
            executionTarget: request.executionTarget,
            expectsResult: true,
            isAsync: false,
            lowPriority: false,
          },
        ],
      }),
      timeoutMs,
      `${this.server.id} ${request.command}`,
      signal,
    )));

    return responses.flatMap((response) => tsserverDiagnosticsFromResponse(response).map((diagnostic) => tsserverDiagnosticToLsp(diagnostic, text)));
  }

  async pullDiagnostics(file: string, timeoutMs: number, signal?: AbortSignal): Promise<Diagnostic[] | undefined> {
    const connection = this.connection;
    if (!connection) return undefined;
    if (!this.supportsPullDiagnostics()) {
      await this.waitForPullDiagnosticsSupport(this.server.id === "csharp" ? Math.min(timeoutMs, 5_000) : 250, signal);
    }
    if (!this.supportsPullDiagnostics()) return undefined;
    const identifiers = this.diagnosticProviderIdentifiers();
    if (identifiers.length === 0) return undefined;

    const uri = filePathToUri(file);
    const settled = await Promise.allSettled(identifiers.map(async (identifier) => {
      const report = (await withTimeout(
        connection.sendRequest(DocumentDiagnosticRequest.method, {
          textDocument: { uri },
          identifier,
        }),
        timeoutMs,
        `${this.server.id} textDocument/diagnostic${identifier ? ` (${identifier})` : ""}`,
        signal,
      )) as DocumentDiagnosticReport | null;
      return this.diagnosticsFromReport(report) ?? [];
    }));

    const fulfilled = settled.filter((result): result is PromiseFulfilledResult<Diagnostic[]> => result.status === "fulfilled");
    if (fulfilled.length === 0) {
      const firstError = settled.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
      throw firstError instanceof Error ? firstError : new Error(String(firstError ?? "pull diagnostics failed"));
    }

    const seen = new Set<string>();
    return fulfilled.flatMap((result) => result.value).filter((diagnostic) => {
      const key = JSON.stringify([diagnostic.range, diagnostic.severity, diagnostic.source, diagnostic.code, diagnostic.message]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async hover(file: string, line: number, character: number): Promise<unknown> {
    if (!this.connection) throw new Error(`${this.server.id}: LSP connection unavailable`);
    return withTimeout(
      this.connection.sendRequest(HoverRequest.method, {
        textDocument: { uri: filePathToUri(file) },
        position: { line, character },
      }),
      REQUEST_TIMEOUT_MS,
      `${this.server.id} hover`,
    );
  }

  async definition(file: string, line: number, character: number): Promise<unknown> {
    if (!this.connection) throw new Error(`${this.server.id}: LSP connection unavailable`);
    return withTimeout(
      this.connection.sendRequest(DefinitionRequest.method, {
        textDocument: { uri: filePathToUri(file) },
        position: { line, character },
      }),
      REQUEST_TIMEOUT_MS,
      `${this.server.id} definition`,
    );
  }

  async references(file: string, line: number, character: number, includeDeclaration: boolean): Promise<unknown> {
    if (!this.connection) throw new Error(`${this.server.id}: LSP connection unavailable`);
    return withTimeout(
      this.connection.sendRequest(ReferencesRequest.method, {
        textDocument: { uri: filePathToUri(file) },
        position: { line, character },
        context: { includeDeclaration },
      }),
      REQUEST_TIMEOUT_MS,
      `${this.server.id} references`,
    );
  }

  async symbols(file: string): Promise<unknown> {
    if (!this.connection) throw new Error(`${this.server.id}: LSP connection unavailable`);
    return withTimeout(
      this.connection.sendRequest(DocumentSymbolRequest.method, {
        textDocument: { uri: filePathToUri(file) },
      }),
      REQUEST_TIMEOUT_MS,
      `${this.server.id} document symbols`,
    );
  }

  async shutdown(): Promise<void> {
    const connection = this.connection;
    const child = this.process;
    this.connection = undefined;
    this.process = undefined;
    this.initialized = false;
    this.startPromise = undefined;

    if (child) {
      await bestEffortWriteJsonRpc(child, { jsonrpc: "2.0", id: "pi-lsp-shutdown", method: "shutdown" });
      await bestEffortWriteJsonRpc(child, { jsonrpc: "2.0", method: "exit" });
    }

    connection?.dispose();

    if (child) {
      await terminateChild(child);
    }
  }

  shutdownSync(): void {
    const connection = this.connection;
    const child = this.process;
    this.connection = undefined;
    this.process = undefined;
    this.initialized = false;
    this.startPromise = undefined;

    connection?.dispose();

    if (child && isChildRunning(child)) killChild(child, "SIGKILL");
  }
}
