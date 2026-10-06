import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_DIAGNOSTICS_WAIT_MS, DEFAULT_MAX_FILE_SIZE_BYTES, LSP_MANAGER_GLOBAL_KEY } from "./constants";
import { DiagnosticsStore } from "./diagnostics-store";
import { LspClient } from "./client";
import { LspIdleCleanup, type IdleCleanupOptions } from "./idle-cleanup";
import { loadLspConfig } from "./_shared/config";
import { isPathIncluded } from "./_shared/glob";
import { filePathToUri, findProjectRoot, normalizeRelativePath, resolveCommand, toAbsolutePath } from "./_shared/paths";
import { formatLspDiagnostics, formatWarnings, joinSections, LSP_DIAGNOSTIC_ICON } from "./_shared/output";
import type { LspServerConfig, StoredDiagnostics } from "./_shared/types";
import { canonicalLspPath, clientKey, couldMatchBeforeRoot, fileSizeAllowed, languageIdForFile, readTextFile } from "./lsp-utils";
import { withAbort } from "./async";
import { localMarkdownDiagnostics } from "./markdown-diagnostics";
import type { MatchedServer } from "./types";

export interface ApprovedLspConfig {
  items: LspServerConfig[];
  warnings: string[];
  workspace: string;
}

function isFreshDiagnosticsEntry(entry: StoredDiagnostics | undefined, since: number, version: number | undefined): entry is StoredDiagnostics {
  return !!entry
    && entry.updatedAt >= since
    && (entry.version === undefined || version === undefined || entry.version >= version);
}

function diagnosticsWithLocalFallback(serverId: string, file: string, text: string, diagnostics: StoredDiagnostics["diagnostics"]): StoredDiagnostics["diagnostics"] {
  if (serverId !== "markdown") return diagnostics;
  const hasLanguageServerLinkDiagnostics = diagnostics.some((diagnostic) => typeof diagnostic.code === "string" && diagnostic.code.startsWith("link."));
  const localDiagnostics = localMarkdownDiagnostics(file, text).filter((diagnostic) => {
    if (!hasLanguageServerLinkDiagnostics) return true;
    return !(typeof diagnostic.code === "string" && diagnostic.code.startsWith("link."));
  });
  if (localDiagnostics.length === 0) return diagnostics;

  const seen = new Set(diagnostics.map((diagnostic) => JSON.stringify([diagnostic.range, diagnostic.severity, diagnostic.source, diagnostic.code, diagnostic.message])));
  return [
    ...diagnostics,
    ...localDiagnostics.filter((diagnostic) => {
      const key = JSON.stringify([diagnostic.range, diagnostic.severity, diagnostic.source, diagnostic.code, diagnostic.message]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}

export class LspManager {
  private readonly diagnostics = new DiagnosticsStore();
  private readonly clients = new Map<string, LspClient>();
  private readonly idle: LspIdleCleanup<LspClient>;
  private readonly records = new Map<string, LspClient["runtimeStatus"]>();
  private readonly backoff = new Map<string, { retryAt: number; attempts: number; reason: string }>();
  private generation = 0;
  private disposed = false;
  private readonly stopped = new Set<string>();
  private readonly stopRevisions = new Map<string, number>();
  private readonly stopping = new Map<string, Promise<void>>();
  private handlingSignal = false;
  private readonly handleProcessExit = () => {
    this.shutdownAllSync();
  };
  private readonly handleProcessSignal = (signal: NodeJS.Signals) => {
    this.shutdownAllSync();

    // Restore the platform default for the terminating signal. LSP servers are
    // spawned detached so they can otherwise outlive Pi when the process is
    // killed by a terminal/editor without a session_shutdown event.
    if (this.handlingSignal) return;
    this.handlingSignal = true;
    process.kill(process.pid, signal);
  };

  constructor(private readonly configLoader: (ctx: ExtensionContext) => Promise<ApprovedLspConfig> = async (ctx) => {
    const loaded = await loadLspConfig(ctx);
    const projectLayer = loaded.layers.find((layer) => layer.scope === "project");
    return { items: loaded.items, warnings: loaded.warnings, workspace: projectLayer ? path.dirname(projectLayer.dir) : ctx.cwd };
  }, idleOptions: IdleCleanupOptions = {}) {
    this.idle = new LspIdleCleanup((client) => { void this.retireIdleClient(client); }, idleOptions);
    process.once("exit", this.handleProcessExit);
    process.once("SIGINT", this.handleProcessSignal);
    process.once("SIGTERM", this.handleProcessSignal);
    process.once("SIGHUP", this.handleProcessSignal);
  }

  async matchingServers(ctx: ExtensionContext, file: string): Promise<{ matches: MatchedServer[]; warnings: string[]; workspace: string }> {
    file = canonicalLspPath(file);
    const cwd = canonicalLspPath(ctx.cwd);
    const loaded = await this.configLoader(ctx);
    const warnings = [...loaded.warnings];
    const workspace = canonicalLspPath(loaded.workspace);
    const matches: MatchedServer[] = [];

    for (const server of loaded.items) {
      if (server.enabled === false) continue;
      if (!couldMatchBeforeRoot(file, cwd, server.include, server.exclude)) continue;

      const root = findProjectRoot(file, server.rootMarkers, cwd);
      if (!root) {
        warnings.push(`${server.id}: root markers not found (${(server.rootMarkers ?? []).join(", ") || "none"})`);
        continue;
      }
      const relFile = normalizeRelativePath(path.relative(root, file));
      if (relFile.startsWith("..") || path.isAbsolute(relFile)) continue;
      if (!isPathIncluded(relFile, server.include, server.exclude)) continue;
      matches.push({ server, root, relFile });
    }

    return { matches, warnings, workspace };
  }

  private async getClient(server: LspServerConfig, root: string, file: string, workspace: string, signal?: AbortSignal, generation = this.generation): Promise<LspClient> {
    root = canonicalLspPath(root);
    const key = clientKey(server.id, root);
    if (this.disposed || generation !== this.generation) throw new Error("LSP owner stopped");
    if (signal?.aborted) throw new Error("aborted");
    if (this.stopped.has(key) || this.stopping.has(key)) throw new Error(`${server.id}: LSP stopped by user`);
    const backoff = this.backoff.get(key);
    if (backoff && Date.now() < backoff.retryAt) {
      throw new Error(`${server.id}: unavailable (${backoff.reason}); retry after ${new Date(backoff.retryAt).toISOString()}`);
    }

    let client = this.clients.get(key);
    if (client?.isUnavailable) {
      this.idle.forget(client);
      // A failed transport can still own a live process. Keep it in the map
      // until teardown finishes, then re-check ownership and concurrent retries.
      await withAbort(client.shutdown(), signal);
      if (this.clients.get(key) === client) this.clients.delete(key);
      return this.getClient(server, root, file, workspace, signal, generation);
    }
    if (!client) {
      const command = resolveCommand(server.id, server, { workspace: canonicalLspPath(workspace), root, file: canonicalLspPath(file) });
      const created: LspClient = new LspClient(server, root, command, this.diagnostics,
        () => this.clients.get(key) === created && !created.isUnavailable ? this.idle.begin(created) : () => {});
      client = created;
      this.clients.set(key, client);
      this.records.set(key, { id: server.id, root, state: "stopped" });
    }

    try {
      await client.ensureStarted(signal);
      if (this.disposed || generation !== this.generation || this.clients.get(key) !== client || this.stopped.has(key)) throw new Error("LSP owner stopped");
      this.backoff.delete(key);
      return client;
    } catch (error) {
      if (client.isUnavailable) this.idle.forget(client);
      if (signal?.aborted) throw error;
      if (generation !== this.generation || this.clients.get(key) !== client) throw error;
      const previous = this.backoff.get(key);
      const attempts = (previous?.attempts ?? 0) + 1;
      const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6));
      this.backoff.set(key, { attempts, retryAt: Date.now() + delayMs, reason: (error as Error).message });
      throw error;
    }
  }

  async updateDiagnosticsForFile(ctx: ExtensionContext, file: string): Promise<string> {
    const generation = this.generation;
    file = canonicalLspPath(file);
    const { matches, warnings, workspace } = await this.matchingServers(ctx, file);
    if (matches.length === 0) return formatWarnings("LSP diagnostics", warnings);

    const lines: string[] = [];
    for (const match of matches) {
      let finishActivity: (() => void) | undefined;
      try {
        const maxFileSizeBytes = match.server.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
        if (!(await fileSizeAllowed(file, maxFileSizeBytes))) {
          lines.push(`${LSP_DIAGNOSTIC_ICON} ${match.server.id}: skipped ${match.relFile}; file exceeds maxFileSizeBytes (${maxFileSizeBytes})`);
          continue;
        }

        // Clear stale diagnostics before refreshing this file. The synchronous
        // wait below must observe a fresh publishDiagnostics notification, not an
        // old error from a previous document version. Empty diagnostics published
        // by the server are stored, but this local clear is not.
        this.diagnostics.clear(match.server.id, match.root, filePathToUri(file));

        const text = await readTextFile(file);
        const client = await this.getClient(match.server, match.root, file, workspace, ctx.signal, generation);
        finishActivity = this.idle.begin(client);
        const languageId = languageIdForFile(match.server, file);
        const startedAt = Date.now();
        const doc = await client.openOrChange(file, languageId, text, ctx.signal);
        await client.didSave(file);
        const diagnosticsWaitMs = match.server.diagnosticsWaitMs ?? DEFAULT_DIAGNOSTICS_WAIT_MS;

        // typescript-language-server sometimes does not emit a fresh
        // textDocument/publishDiagnostics notification after didChange/didSave,
        // even though tsserver can answer diagnostics synchronously. Prefer the
        // explicit tsserver request when the server exposes it, so post-edit
        // diagnostics don't degrade into a misleading publishDiagnostics timeout.
        let tsserverFallbackError: string | undefined;
        try {
          const tsserverDiagnostics = await client.tsserverDiagnostics(file, text, diagnosticsWaitMs, ctx.signal);
          if (tsserverDiagnostics !== undefined) {
            const diagnostics = diagnosticsWithLocalFallback(match.server.id, file, text, tsserverDiagnostics);
            this.diagnostics.set(match.server.id, match.root, filePathToUri(file), diagnostics, doc.version);
            lines.push(formatLspDiagnostics(match.server.id, file, diagnostics, match.root));
            continue;
          }
        } catch (error) {
          tsserverFallbackError = (error as Error).message;
        }

        let pullDiagnosticsError: string | undefined;
        if (match.server.pullDiagnostics !== false) {
          try {
            const pulledDiagnostics = await client.pullDiagnostics(file, diagnosticsWaitMs, ctx.signal);
            if (pulledDiagnostics !== undefined) {
              const diagnostics = diagnosticsWithLocalFallback(match.server.id, file, text, pulledDiagnostics);
              this.diagnostics.set(match.server.id, match.root, filePathToUri(file), diagnostics, doc.version);
              lines.push(formatLspDiagnostics(match.server.id, file, diagnostics, match.root));
              continue;
            }
          } catch (error) {
            pullDiagnosticsError = (error as Error).message;
          }
        }

        if (match.server.waitForPublishDiagnostics === false || diagnosticsWaitMs <= 0) {
          continue;
        }

        const entry = await this.diagnostics.waitForFile(
          match.server.id,
          match.root,
          file,
          startedAt,
          doc.version,
          diagnosticsWaitMs,
          ctx.signal,
        );
        if (!isFreshDiagnosticsEntry(entry, startedAt, doc.version)) {
          const fallbackSuffix = tsserverFallbackError ? `; tsserver fallback failed: ${tsserverFallbackError}` : "";
          const pullSuffix = pullDiagnosticsError ? `; pull diagnostics failed: ${pullDiagnosticsError}` : "";
          lines.push(`${LSP_DIAGNOSTIC_ICON} ${match.server.id}: timed out after ${diagnosticsWaitMs}ms waiting for fresh diagnostics for ${match.relFile}${fallbackSuffix}${pullSuffix}`);
          continue;
        }
        const diagnostics = diagnosticsWithLocalFallback(match.server.id, file, text, entry.diagnostics);
        if (diagnostics !== entry.diagnostics) this.diagnostics.set(match.server.id, match.root, filePathToUri(file), diagnostics, doc.version);
        lines.push(formatLspDiagnostics(match.server.id, file, diagnostics, match.root));
      } catch (error) {
        lines.push(`${LSP_DIAGNOSTIC_ICON} ${match.server.id}: ${(error as Error).message}`);
      } finally {
        finishActivity?.();
      }
    }

    return [formatWarnings("LSP diagnostics", warnings), joinSections("LSP diagnostics", lines)].filter(Boolean).join("\n\n");
  }

  async ensureDocumentForTool(ctx: ExtensionContext, inputPath: string): Promise<{ file: string; match: MatchedServer; client: LspClient; workspace: string } | undefined> {
    const generation = this.generation;
    const file = canonicalLspPath(toAbsolutePath(inputPath, ctx.cwd));
    const { matches, workspace } = await this.matchingServers(ctx, file);
    const match = matches[0];
    if (!match) return undefined;
    const text = await readTextFile(file);
    const client = await this.getClient(match.server, match.root, file, workspace, ctx.signal, generation);
    await client.openOrChange(file, languageIdForFile(match.server, file), text, ctx.signal);
    return { file, match, client, workspace };
  }

  diagnosticsForPath(ctx: ExtensionContext, inputPath: string): string {
    const file = canonicalLspPath(toAbsolutePath(inputPath, ctx.cwd));
    const entries = this.diagnostics.getAllForFile(file);
    if (entries.length === 0) return `LSP diagnostics:\n\n✅ no diagnostics recorded for ${file}`;
    return joinSections(
      "LSP diagnostics",
      entries.map((entry) => formatLspDiagnostics(entry.serverId, entry.file, entry.diagnostics, entry.root)),
    );
  }

  async shutdownAll({ preserveControlState = false }: { preserveControlState?: boolean } = {}): Promise<void> {
    this.generation += 1;
    this.idle.clear();
    const clients = [...this.clients.values()];
    if (preserveControlState) {
      for (const client of clients) {
        const { id, root, state, error } = client.runtimeStatus;
        const key = clientKey(id, root);
        const retainFailure = state === "failed" && !this.stopped.has(key);
        this.records.set(key, retainFailure ? { id, root, state, error } : { id, root, state: "stopped" });
      }
    } else {
      this.records.clear();
      this.stopped.clear();
      this.stopRevisions.clear();
      this.backoff.clear();
    }
    this.clients.clear();
    await Promise.allSettled([...clients.map((client) => client.shutdown()), ...this.stopping.values()]);
  }

  runtimeSnapshot() {
    const snapshots = new Map(this.records);
    for (const [key, client] of this.clients) snapshots.set(key, client.runtimeStatus);
    return [...snapshots.values()];
  }

  async stopServer(id: string, root: string): Promise<void> {
    root = canonicalLspPath(root);
    const key = clientKey(id, root);
    this.stopRevisions.set(key, this.stopRevision(id, root) + 1);
    this.stopped.add(key);
    const client = this.clients.get(key);
    if (client || this.records.has(key)) this.records.set(key, { id, root, state: "stopped" });
    if (client) this.idle.forget(client);
    const pending = this.stopping.get(key);
    if (pending) return pending;
    if (!client) return;
    const shutdown = client.shutdown();
    this.stopping.set(key, shutdown);
    try { await shutdown; }
    finally {
      if (this.clients.get(key) === client) this.clients.delete(key);
      this.stopping.delete(key);
      this.backoff.delete(key);
    }
  }

  async startServer(server: LspServerConfig, root: string, workspace: string, generation = this.generation, signal?: AbortSignal): Promise<void> {
    root = canonicalLspPath(root);
    const key = clientKey(server.id, root);
    if (this.stopping.has(key)) throw new Error(`${server.id}: LSP is stopping`);
    this.stopped.delete(key);
    this.backoff.delete(key);
    await this.getClient(server, root, root, workspace, signal, generation);
  }

  get ownerGeneration(): number { return this.generation; }

  stopRevision(id: string, root: string): number { return this.stopRevisions.get(clientKey(id, canonicalLspPath(root))) ?? 0; }

  shutdownAllSync(): void {
    this.disposed = true;
    this.generation += 1;
    this.idle.clear();
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.records.clear();
    this.stopped.clear();
    this.stopRevisions.clear();
    this.backoff.clear();
    process.off("exit", this.handleProcessExit);
    process.off("SIGINT", this.handleProcessSignal);
    process.off("SIGTERM", this.handleProcessSignal);
    process.off("SIGHUP", this.handleProcessSignal);
    for (const client of clients) client.shutdownSync();
  }

  private async retireIdleClient(client: LspClient): Promise<void> {
    const { id, root } = client.runtimeStatus;
    const key = clientKey(id, root);
    if (this.clients.get(key) !== client) return;
    // Keep the closing client mapped so new acquisition waits for its teardown.
    await client.shutdown();
    if (this.clients.get(key) === client) {
      this.clients.delete(key);
      this.records.delete(key);
    }
  }
}

export function getGlobalLspManager(): LspManager {
  const globalState = globalThis as typeof globalThis & { [LSP_MANAGER_GLOBAL_KEY]?: LspManager };
  globalState[LSP_MANAGER_GLOBAL_KEY] ??= new LspManager();
  return globalState[LSP_MANAGER_GLOBAL_KEY];
}
