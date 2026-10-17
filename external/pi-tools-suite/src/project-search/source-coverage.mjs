/** Writer-recorded proof that a complete, stable indexing pass covered one
 * logical source revision under one embedding identity. Probes compare the
 * current revision digest with this set; no receipt, root path, configuration
 * file stamp or policy revision participates. Mirrored verbatim into ACP. */
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { openDatabase } from "./source-work.mjs";

const TABLE = "pix_source_coverage";
const DEFINITION = `CREATE TABLE ${TABLE}(digest TEXT PRIMARY KEY, recorded_at INTEGER NOT NULL)`;
const normalize = sql => sql.replace(/\bIF NOT EXISTS\b/gi, "").replace(/[\s;"`\[\]]/g, "").toLowerCase();
const sha256 = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Retained digests per source: branch/catalogue switches may revisit a prior
 * revision whose vectors are still retained. Pruning sources keep one. */
export const COVERAGE_KEEP = Object.freeze({ settings: 16, commits: 8, sessions: 1, tasks: 1 });

/** Same field order as ACP semanticEmbeddingIdentity(). */
export function coverageIdentity(config) {
  return config ? JSON.stringify([1, config.provider, config.model, config.dimension, config.queryPrefix, config.documentPrefix, config.baseUrl]) : null;
}
export function coverageDigest(source, revision, identity) {
  return sha256(["source-coverage-v1", source, revision, identity ?? null]);
}
/** Desktop/CLI authored-catalogue digest; explicit key order. */
export function settingsCatalogueDigest(settings) {
  return createHash("sha256").update(JSON.stringify(settings.map(({ id, section, label, description, synonyms }) =>
    ({ id, section, label, description: description ?? "", synonyms: [...synonyms] })))).digest("hex");
}
/** Inside the caller's write transaction. */
export function recordCoverage(db, digest, keep, now = Date.now()) {
  if (!/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(keep) || keep < 1) throw new Error("Invalid source coverage");
  db.exec(DEFINITION.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"));
  db.prepare(`INSERT INTO ${TABLE} VALUES(?,?) ON CONFLICT(digest) DO UPDATE SET recorded_at=excluded.recorded_at`).run(digest, now);
  // The just-recorded digest always survives, even with equal timestamps.
  db.prepare(`DELETE FROM ${TABLE} WHERE digest NOT IN (SELECT digest FROM ${TABLE}
    ORDER BY digest=? DESC, recorded_at DESC, rowid DESC LIMIT ?)`).run(digest, keep);
}
/** Read-only. undefined: no database or no coverage table (legacy/never
 * recorded) so callers can distinguish "unknown" from "not covered". */
export async function readCoverage(filename, signal) {
  signal?.throwIfAborted();
  if (!await lstat(filename).catch(error => { if (error.code !== "ENOENT") throw error; })) return undefined;
  const db = await openDatabase(filename, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN");
    const table = db.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(TABLE);
    if (!table) return undefined;
    if (table.type !== "table" || normalize(table.sql) !== normalize(DEFINITION)) throw new Error("Unsafe source coverage");
    const digests = new Set();
    for (const row of db.prepare(`SELECT digest FROM ${TABLE} ORDER BY recorded_at DESC LIMIT 64`).iterate()) {
      if (typeof row.digest === "string" && /^[a-f0-9]{64}$/.test(row.digest)) digests.add(row.digest);
    }
    signal?.throwIfAborted();
    return digests;
  } finally { try { db.exec("ROLLBACK"); } catch { /* BEGIN may have failed. */ } finally { db.close(); } }
}
