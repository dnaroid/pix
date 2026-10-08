import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldTask } from "node:timers/promises";
import { resolve } from "node:path";
import type { SessionMapRecord } from "../acp/session-map.js";
import { SEARCH_EMBEDDING_MODEL } from "./contract.js";
import { hashText } from "./documents.js";
import { EMBEDDING_DIMENSIONS, validVector } from "./embeddings.js";

/** Separate schema/embedding identity from settings, commits, and future IDX tables. */
export const SESSION_META = "pix_session_meta";
export const SESSION_TITLES = "pix_session_titles";
export const SESSION_VECTORS = "pix_session_vectors";
const FORMAT = "float32le";

export interface NamedSessionTitle {
  readonly sessionId: string;
  readonly title: string;
  readonly hash: string;
}
export interface StoredSessionVector {
  readonly hash: string;
  readonly vector: number[];
}

/** Never embed the UI's first-user-message fallback for unnamed sessions. */
export function namedSessionTitles(records: readonly SessionMapRecord[], cwd: string): NamedSessionTitle[] {
  const selected = new Map<string, NamedSessionTitle>();
  for (const record of records) {
    if (resolve(record.cwd) !== cwd) continue;
    const title = record.namedTitle?.trim();
    if (!title || title !== record.title?.trim() || title.length > 2000 || title.includes("\0")) continue;
    selected.set(record.sessionId, { sessionId: record.sessionId, title, hash: hashText(title) });
  }
  return [...selected.values()];
}

export interface SessionIndexTransaction {
  reconcile(records: readonly NamedSessionTitle[]): void;
  missing(limit: number): NamedSessionTitle[];
  save(vectors: ReadonlyMap<string, number[]>): void;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function schemaIsCompatible(db: DatabaseSync): boolean {
  const values = new Map<string, string>();
  for (const row of db.prepare(`SELECT key,value FROM ${SESSION_META}`).iterate()) {
    if (typeof row.key === "string" && typeof row.value === "string") values.set(row.key, row.value);
  }
  return values.get("model") === SEARCH_EMBEDDING_MODEL
    && values.get("dimensions") === String(EMBEDDING_DIMENSIONS)
    && values.get("encoding") === FORMAT;
}

export function createSessionIndexTransaction(db: DatabaseSync, signal: AbortSignal): SessionIndexTransaction {
  db.exec(`CREATE TABLE IF NOT EXISTS ${SESSION_META} (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ${SESSION_TITLES} (session_id TEXT PRIMARY KEY, title TEXT NOT NULL, title_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ${SESSION_VECTORS} (title_hash TEXT PRIMARY KEY, vector BLOB NOT NULL);
    CREATE INDEX IF NOT EXISTS pix_session_titles_by_hash ON ${SESSION_TITLES}(title_hash);`);
  const metadata = db.prepare(`SELECT COUNT(*) AS count FROM ${SESSION_META}`).get()?.count;
  if (metadata === 0) {
    const insert = db.prepare(`INSERT INTO ${SESSION_META} VALUES (?,?)`);
    insert.run("model", SEARCH_EMBEDDING_MODEL);
    insert.run("dimensions", String(EMBEDDING_DIMENSIONS));
    insert.run("encoding", FORMAT);
  } else if (!schemaIsCompatible(db)) {
    // Do not discard existing paid vectors because an unknown model's
    // metadata was found. Fail closed until a deliberate migration exists.
    throw new Error("Session title embedding identity is incompatible");
  }
  db.exec("CREATE TEMP TABLE IF NOT EXISTS pix_live_session_ids (session_id TEXT PRIMARY KEY)");
  const saveTitle = db.prepare(`INSERT INTO ${SESSION_TITLES} (session_id,title,title_hash) VALUES (?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET title=excluded.title,title_hash=excluded.title_hash
    WHERE title!=excluded.title OR title_hash!=excluded.title_hash`);
  const saveLive = db.prepare("INSERT OR IGNORE INTO pix_live_session_ids VALUES (?)");
  const addVector = db.prepare(`INSERT INTO ${SESSION_VECTORS} VALUES (?,?)
    ON CONFLICT(title_hash) DO NOTHING`);
  return {
    reconcile(records): void {
      db.exec("DELETE FROM pix_live_session_ids");
      for (const record of records) {
        signal.throwIfAborted();
        saveLive.run(record.sessionId);
        saveTitle.run(record.sessionId, record.title, record.hash);
      }
      db.exec(`DELETE FROM ${SESSION_TITLES} WHERE session_id NOT IN (SELECT session_id FROM pix_live_session_ids);
        DELETE FROM ${SESSION_VECTORS} WHERE title_hash NOT IN (SELECT title_hash FROM ${SESSION_TITLES});`);
    },
    missing(limit): NamedSessionTitle[] {
      const rows: NamedSessionTitle[] = [];
      for (const row of db.prepare(`SELECT t.session_id,t.title,t.title_hash FROM ${SESSION_TITLES} t
        LEFT JOIN ${SESSION_VECTORS} v ON v.title_hash=t.title_hash
        WHERE v.title_hash IS NULL GROUP BY t.title_hash ORDER BY t.session_id LIMIT ?`).iterate(limit)) {
        signal.throwIfAborted();
        if (typeof row.session_id === "string" && typeof row.title === "string" && typeof row.title_hash === "string") {
          rows.push({ sessionId: row.session_id, title: row.title, hash: row.title_hash });
        }
      }
      return rows;
    },
    save(vectors): void {
      for (const [hash, values] of vectors) {
        signal.throwIfAborted();
        if (!validVector(values)) throw new Error("Invalid session title vector");
        if (!db.prepare(`SELECT 1 FROM ${SESSION_TITLES} WHERE title_hash=?`).get(hash)) continue;
        const bytes = Buffer.alloc(EMBEDDING_DIMENSIONS * 4);
        values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
        addVector.run(hash, bytes);
      }
    },
  };
}

/** Read-only snapshot; does not create a DB or expose session texts. */
export async function loadSessionTitleVectors(db: DatabaseSync, signal: AbortSignal): Promise<Map<string, StoredSessionVector>> {
  const found = new Map<string, StoredSessionVector>();
  if (!tableExists(db, SESSION_META) || !tableExists(db, SESSION_TITLES) || !tableExists(db, SESSION_VECTORS)) return found;
  if (!schemaIsCompatible(db)) return found;
  let count = 0;
  for (const row of db.prepare(`SELECT t.session_id, t.title_hash, v.vector FROM ${SESSION_TITLES} t
    JOIN ${SESSION_VECTORS} v ON v.title_hash=t.title_hash`).iterate()) {
    signal.throwIfAborted();
    if (typeof row.session_id === "string" && typeof row.title_hash === "string" && row.vector instanceof Uint8Array
      && row.vector.byteLength === EMBEDDING_DIMENSIONS * 4) {
      const bytes = Buffer.from(row.vector);
      const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => bytes.readFloatLE(i * 4));
      if (validVector(vector)) found.set(row.session_id, { hash: row.title_hash, vector });
    }
    if (++count % 32 === 0) await yieldTask();
  }
  return found;
}
