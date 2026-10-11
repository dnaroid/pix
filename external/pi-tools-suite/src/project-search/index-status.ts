import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { safeFile, sourcePath } from "./source-work.mjs";
import { INDEX_SOURCES, type IndexSource } from "./index-runner.js";
import type { SqlDatabase } from "./semantic-index-writer.js";

const tables: Record<IndexSource, readonly [string, string]> = {
  code: ["pix_native_chunks", "vectors"], knowledge: ["pix_native_chunks", "vectors"],
  sessions: ["pix_session_titles", "pix_session_vectors"], tasks: ["pix_task_documents", "pix_task_vectors"],
  commits: ["pix_commit_documents", "pix_commit_vectors"],
};

/** Read-only diagnostics: no schema initialization, recovery, or provider calls.
 * Counts mean stored rows, not current corpus coverage or model compatibility. */
export async function readIndexStatus(root: string): Promise<string[]> {
  return Promise.all(INDEX_SOURCES.map(async source => {
    let db: SqlDatabase | undefined;
    try {
      for (const folder of [join(root, ".pi"), join(root, ".pi/search")]) {
        const info = await lstat(folder).catch(error => { if (error.code !== "ENOENT") throw error; });
        if (!info) return `${source}: no stored index`;
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe directory");
      }
      const filename = sourcePath(root, source);
      await safeFile(filename);
      if (!await lstat(filename).catch(error => { if (error.code !== "ENOENT") throw error; })) return `${source}: no stored index`;
      if ("Bun" in globalThis) {
        const driver = "bun:sqlite";
        const { Database } = await import(driver);
        db = new Database(filename, { readonly: true });
      } else {
        const { DatabaseSync } = await import("node:sqlite");
        db = new DatabaseSync(filename, { readOnly: true }) as unknown as SqlDatabase;
      }
      const connection = db!;
      connection.exec("PRAGMA busy_timeout=200; BEGIN");
      const available = new Set(connection.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
      const counts = tables[source].map(table => available.has(table)
        ? Number(connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0) : 0);
      connection.exec("COMMIT");
      return `${source}: ${counts[0]} stored items, ${counts[1]} stored vectors`;
    } catch { return `${source}: stored index unavailable`; }
    finally { db?.close(); }
  }));
}
