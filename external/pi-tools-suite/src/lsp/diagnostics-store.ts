import type { Diagnostic } from "vscode-languageserver-protocol";
import { delay } from "./async";
import { uriToFilePath } from "./_shared/paths";
import type { StoredDiagnostics } from "./_shared/types";

export class DiagnosticsStore {
  private readonly diagnostics = new Map<string, StoredDiagnostics>();

  private key(serverId: string, root: string, file: string): string {
    return `${serverId}\u0000${root}\u0000${file}`;
  }

  set(serverId: string, root: string, uri: string, diagnostics: Diagnostic[], version?: number): void {
    const file = uriToFilePath(uri);
    const key = this.key(serverId, root, file);
    this.diagnostics.set(key, {
      serverId,
      root,
      file,
      version,
      diagnostics,
      updatedAt: Date.now(),
    });
  }

  clear(serverId: string, root: string, uri: string): void {
    this.diagnostics.delete(this.key(serverId, root, uriToFilePath(uri)));
  }

  get(serverId: string, root: string, file: string): StoredDiagnostics | undefined {
    return this.diagnostics.get(this.key(serverId, root, file));
  }

  async waitForFile(
    serverId: string,
    root: string,
    file: string,
    since: number,
    version: number | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<StoredDiagnostics | undefined> {
    const deadline = Date.now() + Math.max(0, timeoutMs);

    while (true) {
      const entry = this.get(serverId, root, file);
      if (entry && entry.updatedAt >= since) {
        // Some language servers omit diagnostic versions. If present, require
        // diagnostics for the document version we just sent or newer.
        if (entry.version === undefined || version === undefined || entry.version >= version) {
          return entry;
        }
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) return this.get(serverId, root, file);
      await delay(Math.min(50, remaining), signal);
    }
  }

  getAllForFile(file: string): StoredDiagnostics[] {
    return [...this.diagnostics.values()].filter((entry) => entry.file === file);
  }
}
