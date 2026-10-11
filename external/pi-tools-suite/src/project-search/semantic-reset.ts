import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { withSearchIndexWriter, type SqlDatabase } from "./semantic-index-writer.js";

const namespaces = [
  { meta: "pix_task_index_meta", vectors: "pix_task_vectors", columns: "content_hash:TEXT,vector:BLOB" },
  { meta: "pix_session_meta", vectors: "pix_session_vectors", columns: "title_hash:TEXT,vector:BLOB" },
  { meta: "pix_commit_meta", vectors: "pix_commit_vectors", columns: "hash:TEXT,vector:TEXT" },
  { meta: "metadata", vectors: "vectors", columns: "hash:TEXT,vector:BLOB" },
] as const;

function validateTable(db: SqlDatabase, table: string, columns: string): boolean {
  const entry = db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(table);
  if (!entry) return false;
  const shape = db.prepare(`PRAGMA table_info(${table})`).all().map(row => `${row.name}:${row.type}`).join(",");
  if (entry.type !== "table" || shape !== columns || db.prepare(`PRAGMA foreign_key_list(${table})`).all().length) {
    throw new Error("Unrecognized semantic cache schema");
  }
  // Do not let a custom DELETE trigger turn this scoped reset into another mutation.
  if (db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table)
    .some(row => /\bDELETE\s+ON\b/i.test(String(row.sql).replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, " ")))) throw new Error("Unexpected semantic cache trigger");
  return true;
}

/** Explicit user command only. Never unlink the shared index or canonical history. */
export async function resetHistoryVectors(root: string, signal: AbortSignal): Promise<number> {
  const exists = await lstat(join(root, ".pi/search/index.sqlite")).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!exists) return 0;
  return withSearchIndexWriter(root, signal, async db => {
    const present = namespaces.filter(namespace => {
      const meta = validateTable(db, namespace.meta, "key:TEXT,value:TEXT");
      const vectors = validateTable(db, namespace.vectors, namespace.columns);
      if (meta !== vectors) throw new Error("Incomplete semantic cache schema");
      if (meta && namespace.meta === "metadata"
        && db.prepare("SELECT value FROM metadata WHERE key='schema'").get()?.value !== "2") {
        throw new Error("Unknown settings cache schema");
      }
      return meta;
    });
    const targets = new Set<string>(present.flatMap(namespace => [namespace.meta, namespace.vectors]));
    for (const table of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      const name = String(table.name).replace(/"/g, '""');
      if (db.prepare(`PRAGMA foreign_key_list("${name}")`).all().some(row => targets.has(String(row.table)))) {
        throw new Error("Unexpected semantic cache dependency");
      }
    }
    let count = 0;
    for (const namespace of present) {
      count += Number(db.prepare(`SELECT COUNT(*) AS count FROM ${namespace.vectors}`).get()?.count ?? 0);
      db.exec(`DELETE FROM ${namespace.vectors}`);
      if (namespace.meta === "metadata") {
        db.exec("DELETE FROM metadata WHERE key IN ('identity','model','dimensions','encoding')");
      } else if (namespace.meta === "pix_commit_meta") {
        db.exec("DELETE FROM pix_commit_meta WHERE key='identity'");
      } else db.exec(`DELETE FROM ${namespace.meta}`);
    }
    return count;
  });
}
