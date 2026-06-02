import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_DIAGNOSTICS_WAIT_MS, DEFAULT_MAX_FILE_SIZE_BYTES, LSP_MANAGER_GLOBAL_KEY } from "./constants";
import { DiagnosticsStore } from "./diagnostics-store";
import { LspClient } from "./client";
import { loadLspConfig } from "./_shared/config";
import { isPathIncluded } from "./_shared/glob";
import { filePathToUri, findProjectRoot, normalizeRelativePath, resolveCommand, toAbsolutePath } from "./_shared/paths";
import { formatLspDiagnostics, formatWarnings, joinSections, LSP_DIAGNOSTIC_ICON } from "./_shared/output";
import type { LspServerConfig, StoredDiagnostics } from "./_shared/types";
import { clientKey, couldMatchBeforeRoot, fileSizeAllowed, languageIdForFile, readTextFile } from "./lsp-utils";
import { localMarkdownDiagnostics } from "./markdown-diagnostics";
import type { MatchedServer } from "./types";

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
  private readonly backoff = new Map<string, { retryAt: number; attempts: number; reason: string }>();
  private readonly handleProcessExit = () => {
    this.shutdownAllSync();
  };

  constructor() {
    process.once("exit", this.handleProcessExit);
  }

  async matchingServers(ctx: ExtensionContext, file: string): Promise<{ matches: MatchedServer[]; warnings: string[]; workspace: string }> {
    const loaded = await loadLspConfig(ctx);
    const warnings = [...loaded.warnings];
    const projectLayer = loaded.layers.find((layer) => layer.scope === "project");
    const workspace = projectLayer ? path.dirname(projectLayer.dir) : ctx.cwd;
    const matches: MatchedServer[] = [];

    for (const server of loaded.items) {
      if (server.enabled === false) continue;
      if (!couldMatchBeforeRoot(file, ctx.cwd, server.include, server.exclude)) continue;

      const root = findProjectRoot(file, server.rootMarkers, ctx.cwd);
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

  private async getClient(server: LspServerConfig, root: string, file: string, workspace: string, signal?: AbortSignal): Promise<LspClient> {
    const key = clientKey(server.id, root);
    const backoff = this.backoff.get(key);
    if (backoff && Date.now() < backoff.retryAt) {
      throw new Error(`${server.id}: unavailable (${backoff.reason}); retry after ${new Date(backoff.retryAt).toISOString()}`);
    }

    let client = this.clients.get(key);
    if (!client || client.isUnavailable) {
      const command = resolveCommand(server.id, server, { workspace, root, file });
      client = new LspClient(server, root, command, this.diagnostics);
      this.clients.set(key, client);
    }

    try {
      await client.ensureStarted(signal);
      this.backoff.delete(key);
      return client;
    } catch (error) {
      const previous = this.backoff.get(key);
      const attempts = (previous?.attempts ?? 0) + 1;
      const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6));
      this.backoff.set(key, { attempts, retryAt: Date.now() + delayMs, reason: (error as Error).message });
      throw error;
    }
  }

  async updateDiagnosticsForFile(ctx: ExtensionContext, file: string): Promise<string> {
    const { matches, warnings, workspace } = await this.matchingServers(ctx, file);
    if (matches.length === 0) return formatWarnings("LSP diagnostics", warnings);

    const lines: string[] = [];
    for (const match of matches) {
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
        const client = await this.getClient(match.server, match.root, file, workspace, ctx.signal);
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
      }
    }

    return [formatWarnings("LSP diagnostics", warnings), joinSections("LSP diagnostics", lines)].filter(Boolean).join("\n\n");
  }

  async ensureDocumentForTool(ctx: ExtensionContext, inputPath: string): Promise<{ file: string; match: MatchedServer; client: LspClient; workspace: string } | undefined> {
    const file = toAbsolutePath(inputPath, ctx.cwd);
    const { matches, workspace } = await this.matchingServers(ctx, file);
    const match = matches[0];
    if (!match) return undefined;
    const text = await readTextFile(file);
    const client = await this.getClient(match.server, match.root, file, workspace, ctx.signal);
    await client.openOrChange(file, languageIdForFile(match.server, file), text, ctx.signal);
    return { file, match, client, workspace };
  }

  diagnosticsForPath(ctx: ExtensionContext, inputPath: string): string {
    const file = toAbsolutePath(inputPath, ctx.cwd);
    const entries = this.diagnostics.getAllForFile(file);
    if (entries.length === 0) return `LSP diagnostics:\n\n✅ no diagnostics recorded for ${file}`;
    return joinSections(
      "LSP diagnostics",
      entries.map((entry) => formatLspDiagnostics(entry.serverId, entry.file, entry.diagnostics, entry.root)),
    );
  }

  async shutdownAll(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map((client) => client.shutdown()));
  }

  shutdownAllSync(): void {
    const clients = [...this.clients.values()];
    this.clients.clear();
    process.off("exit", this.handleProcessExit);
    for (const client of clients) client.shutdownSync();
  }
}

export function getGlobalLspManager(): LspManager {
  const globalState = globalThis as typeof globalThis & { [LSP_MANAGER_GLOBAL_KEY]?: LspManager };
  globalState[LSP_MANAGER_GLOBAL_KEY] ??= new LspManager();
  return globalState[LSP_MANAGER_GLOBAL_KEY];
}
