import { createHash } from "node:crypto";
import { freshSemanticCandidates, sessionLinks, type CachedSessionCandidate } from "./semantic-cache.js";
import { embedTaskTexts, semanticConsents, validSearchVector, SEARCH_VECTOR_DIMENSIONS, SEARCH_VECTOR_MODEL,
  type SemanticSearchOptions } from "./semantic-provider.js";
import { withSearchIndexWriter, type SqlDatabase } from "./semantic-index-writer.js";

const BATCH = 16;
const MAX_PER_QUERY = 256;
const DEADLINE_MS = 40_000;

function ensureSessionSchema(db: SqlDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pix_session_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pix_session_titles(session_id TEXT PRIMARY KEY,title TEXT NOT NULL,title_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pix_session_vectors(title_hash TEXT PRIMARY KEY,vector BLOB NOT NULL);
    CREATE INDEX IF NOT EXISTS pix_session_titles_by_hash ON pix_session_titles(title_hash)`);
  const count = Number(db.prepare("SELECT COUNT(*) AS n FROM pix_session_meta").get()?.n ?? 0);
  const expected = [["model", SEARCH_VECTOR_MODEL], ["dimensions", String(SEARCH_VECTOR_DIMENSIONS)], ["encoding", "float32le"]] as const;
  const read = db.prepare("SELECT value FROM pix_session_meta WHERE key=?");
  if (count && expected.some(([key, value]) => read.get(key)?.value !== value)) {
    throw new Error("Saved session title embedding identity is incompatible");
  }
  const put = db.prepare("INSERT INTO pix_session_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  for (const [key, value] of expected) put.run(key, value);
}

/** The cache indexes explicit saved titles only, never first-message fallbacks,
 * first/final transcript boundaries or generated session labels. */
export async function indexMissingSessionVectors(root: string, candidates: readonly CachedSessionCandidate[], key: string,
  options: SemanticSearchOptions, signal: AbortSignal): Promise<{ remaining: number; indexed: number }> {
  if (!candidates.length) return { remaining: 0, indexed: 0 };
  const owned = AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS)]);
  let remaining = 0, indexed = 0;
  for (let batch = 0; batch <= MAX_PER_QUERY / BATCH; batch++) {
    owned.throwIfAborted();
    if (!(await semanticConsents(options, owned)).sessions) break;
    const verified = await freshSemanticCandidates(root, { tasks: [], sessions: candidates }, options, owned);
    const linked = await sessionLinks(root, candidates, options, owned);
    const live = candidates.flatMap(session => {
      const title = linked.get(session.id);
      return verified.sessions.has(session.id) && title
        ? [{ sessionId: title.sessionId, title: title.name, hash: createHash("sha256").update(title.name).digest("hex"), nativeId: session.id }]
        : [];
    });
    if (!live.length) return { remaining: 0, indexed };
    const response = await withSearchIndexWriter(root, owned, async db => {
      ensureSessionSchema(db);
      const put = db.prepare(`INSERT INTO pix_session_titles(session_id,title,title_hash) VALUES(?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET title=excluded.title,title_hash=excluded.title_hash
        WHERE title!=excluded.title OR title_hash!=excluded.title_hash`);
      for (const title of live) put.run(title.sessionId, title.title, title.hash);
      // The discovered session set may be limited to 1,000 most recent items.
      // Do NOT delete older titles we did not enumerate; only prune vectors
      // orphaned by an actual rename of a known session ID.
      db.exec("DELETE FROM pix_session_vectors WHERE title_hash NOT IN (SELECT title_hash FROM pix_session_titles)");
      const has = db.prepare("SELECT 1 AS found FROM pix_session_vectors WHERE title_hash=?");
      const unique = new Set<string>();
      const missing = live.filter(title => !has.get(title.hash) && !unique.has(title.hash) && (unique.add(title.hash), true));
      if (!missing.length || batch === MAX_PER_QUERY / BATCH) return { remaining: missing.length, indexed: 0 };
      const targets = missing.slice(0, BATCH);
      if (!(await semanticConsents(options, owned)).sessions) throw new Error("Session semantic consent revoked");
      const vectors = await (options.embedTasks ?? embedTaskTexts)(targets.map(item => item.title), key, owned);
      owned.throwIfAborted();
      if (!(await semanticConsents(options, owned)).sessions) throw new Error("Session semantic consent revoked");
      if (vectors.length !== targets.length || !vectors.every(validSearchVector)) throw new Error("Invalid session title embedding batch");
      const fresh = await freshSemanticCandidates(root, {
        tasks: [], sessions: candidates.filter(session => targets.some(target => target.nativeId === session.id)),
      }, options, owned);
      if (fresh.sessions.size !== targets.length) throw new Error("Saved session name changed during indexing");
      const nextLinks = await sessionLinks(root, candidates, options, owned);
      for (const target of targets) {
        const now = nextLinks.get(target.nativeId);
        if (now?.sessionId !== target.sessionId || now.name !== target.title) {
          throw new Error("Saved session name changed during indexing");
        }
      }
      const add = db.prepare("INSERT INTO pix_session_vectors(title_hash,vector) VALUES(?,?) ON CONFLICT(title_hash) DO NOTHING");
      for (let i = 0; i < targets.length; i++) {
        const bytes = Buffer.alloc(SEARCH_VECTOR_DIMENSIONS * 4);
        vectors[i]!.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
        add.run(targets[i]!.hash, bytes);
      }
      return { remaining: missing.length - targets.length, indexed: targets.length };
    });
    indexed += response.indexed;
    remaining = response.remaining;
    if (!remaining || !response.indexed) break;
  }
  return { remaining, indexed };
}
