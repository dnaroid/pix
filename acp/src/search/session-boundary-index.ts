import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldTask } from "node:timers/promises";
import type { SessionSearchHit } from "./contract.js";

export const BOUNDARY_META = "pix_session_boundary_meta";
export const BOUNDARY_FTS = "pix_session_boundary_fts";

export interface SessionBoundaryRow {
  readonly sessionId: string;
  readonly path: string;
  readonly fingerprint: string;
  readonly firstText: string;
  readonly finalText: string;
}
export interface SessionBoundaryState {
  readonly path: string;
  readonly fingerprint: string;
}

function exists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name));
}

export async function readSessionBoundaryState(db: DatabaseSync, signal: AbortSignal): Promise<Map<string, SessionBoundaryState>> {
  const current = new Map<string, SessionBoundaryState>();
  if (!exists(db, BOUNDARY_META)) return current;
  let count = 0;
  for (const row of db.prepare(`SELECT session_id,path,fingerprint FROM ${BOUNDARY_META}`).iterate()) {
    signal.throwIfAborted();
    if (typeof row.session_id === "string" && typeof row.path === "string" && typeof row.fingerprint === "string") {
      current.set(row.session_id, { path: row.path, fingerprint: row.fingerprint });
    }
    if (++count % 64 === 0) await yieldTask();
  }
  return current;
}

/** This index never contains embeddings, attachment bytes or tool responses. */
export function reconcileSessionBoundaries(db: DatabaseSync, signal: AbortSignal, live: readonly string[], updates: readonly SessionBoundaryRow[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${BOUNDARY_META} (session_id TEXT PRIMARY KEY, path TEXT NOT NULL, fingerprint TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS ${BOUNDARY_FTS} USING fts5(session_id UNINDEXED, first_text, final_text, tokenize='unicode61');
    CREATE TEMP TABLE IF NOT EXISTS pix_live_boundary_ids (session_id TEXT PRIMARY KEY);`);
  db.exec("DELETE FROM pix_live_boundary_ids");
  const liveId = db.prepare("INSERT OR IGNORE INTO pix_live_boundary_ids VALUES (?)");
  const save = db.prepare(`INSERT INTO ${BOUNDARY_META} VALUES (?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET path=excluded.path, fingerprint=excluded.fingerprint`);
  const removeText = db.prepare(`DELETE FROM ${BOUNDARY_FTS} WHERE session_id=?`);
  const addText = db.prepare(`INSERT INTO ${BOUNDARY_FTS} (session_id,first_text,final_text) VALUES (?,?,?)`);
  for (const id of live) { signal.throwIfAborted(); liveId.run(id); }
  for (const row of updates) {
    signal.throwIfAborted();
    removeText.run(row.sessionId);
    save.run(row.sessionId, row.path, row.fingerprint);
    addText.run(row.sessionId, row.firstText, row.finalText);
  }
  const stale = db.prepare(`SELECT session_id FROM ${BOUNDARY_META}
    WHERE session_id NOT IN (SELECT session_id FROM pix_live_boundary_ids)`).all();
  for (const row of stale) {
    signal.throwIfAborted();
    if (typeof row.session_id === "string") removeText.run(row.session_id);
  }
  db.exec(`DELETE FROM ${BOUNDARY_META} WHERE session_id NOT IN (SELECT session_id FROM pix_live_boundary_ids)`);
}

/** Unicode FTS5 only; never pass untrusted query text as FTS syntax. */
export function sessionBoundaryMatchQuery(query: string): string | undefined {
  const terms = [...new Set(query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 8);
  return terms.length ? terms.map(term => `"${term}"*`).join(" AND ") : undefined;
}

export function sessionBoundaryHits(db: DatabaseSync, query: string, signal: AbortSignal, limit = 60): SessionSearchHit[] {
  const match = sessionBoundaryMatchQuery(query);
  if (!match || !exists(db, BOUNDARY_FTS)) return [];
  const hits: SessionSearchHit[] = [];
  for (const row of db.prepare(`SELECT f.session_id, f.first_text, f.final_text FROM ${BOUNDARY_FTS} f
    JOIN ${BOUNDARY_META} m ON m.session_id=f.session_id
    WHERE ${BOUNDARY_FTS} MATCH ? ORDER BY bm25(${BOUNDARY_FTS}) LIMIT ?`).iterate(match, limit)) {
    signal.throwIfAborted();
    if (typeof row.session_id !== "string") continue;
    const firstText = String(row.first_text ?? "");
    const finalText = String(row.final_text ?? "");
    hits.push({ kind: "sessions", id: `sessions:${row.session_id}`, sessionId: row.session_id,
      title: "", snippet: `First: ${firstText.slice(0, 160)}\nFinal: ${finalText.slice(0, 220)}`,
      score: 1, boundaryMatch: true });
  }
  return hits;
}
