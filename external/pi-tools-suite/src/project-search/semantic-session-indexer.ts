import { createHash } from "node:crypto";
import { withProviderSlot } from "./source-work.mjs";
import { freshSemanticCandidates, sessionLinks, type CachedSessionCandidate } from "./semantic-cache.js";
import { embedTaskTexts, requireSemanticIdentity, validSearchVector,
  type SemanticSearchOptions } from "./semantic-provider.js";
import { commitIdentity, type CommitEmbeddingConfig } from "./semantic-commit-provider.js";
import { withSearchIndexWriter, type SqlDatabase } from "./semantic-index-writer.js";
import type { TranscriptCandidate } from "./session-transcript.mjs";
import { SessionIndexDeferred } from "./session-idle.mjs";
import { ensureSessionRevision } from "./session-index-revision.mjs";

const BATCH = 16;
const MAX_PER_QUERY = 256;
const DEADLINE_MS = 40_000;

function ensureSessionSchema(db: SqlDatabase, config: CommitEmbeddingConfig): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pix_session_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pix_session_titles(session_id TEXT PRIMARY KEY,title TEXT NOT NULL,title_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pix_session_vectors(title_hash TEXT PRIMARY KEY,vector BLOB NOT NULL);
    CREATE INDEX IF NOT EXISTS pix_session_titles_by_hash ON pix_session_titles(title_hash)`);
  ensureSessionRevision(db);
  const count = Number(db.prepare("SELECT COUNT(*) AS n FROM pix_session_meta").get()?.n ?? 0);
  const expected = [["identity", commitIdentity(config)], ["model", config.model], ["dimensions", String(config.dimension)], ["encoding", "float32le"]] as const;
  const read = db.prepare("SELECT value FROM pix_session_meta WHERE key=?");
  if ((count && expected.some(([key, value]) => read.get(key)?.value !== value))
    || (!count && Number(db.prepare("SELECT COUNT(*) AS n FROM pix_session_vectors").get()?.n))) {
    throw new Error("Saved session title embedding identity is incompatible");
  }
  const put = db.prepare("INSERT INTO pix_session_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  for (const [key, value] of expected) put.run(key, value);
}

/** The cache indexes explicit saved titles only, never first-message fallbacks,
 * first/final transcript boundaries or generated session labels. */
export async function indexMissingSessionVectors(root: string, candidates: readonly CachedSessionCandidate[], key: string | undefined,
  options: SemanticSearchOptions, signal: AbortSignal, config: CommitEmbeddingConfig, drain = false,
  eligible?: (candidate: TranscriptCandidate, signal: AbortSignal) => Promise<boolean>, retry = drain): Promise<{ remaining: number; indexed: number }> {
  if (!candidates.length) return { remaining: 0, indexed: 0 };
  const owned = drain ? signal : AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS)]);
  let remaining = 0, indexed = 0;
  for (let batch = 0; drain || batch <= MAX_PER_QUERY / BATCH; batch++) {
    owned.throwIfAborted();
    if (eligible) {
      const admitted = await Promise.all(candidates.map(c => eligible(c,owned)));
      candidates = candidates.filter((_c,i) => admitted[i]);
      if (!candidates.length) return {remaining:0,indexed};
    }
    await requireSourceEnabled(root, "sessions", owned);
    await requireSemanticIdentity(options, config, owned);
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
      await requireSemanticIdentity(options, config, owned);
      ensureSessionSchema(db, config);
      const put = db.prepare(`INSERT INTO pix_session_titles(session_id,title,title_hash) VALUES(?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET title=excluded.title,title_hash=excluded.title_hash
        WHERE title!=excluded.title OR title_hash!=excluded.title_hash`);
      // Discovery is bounded. Retain older titles and all purchased vectors;
      // matching still requires a current authenticated saved-name/hash pair.
      const has = db.prepare("SELECT 1 AS found FROM pix_session_vectors WHERE title_hash=?");
      const unique = new Set<string>();
      const missing = live.filter(title => !has.get(title.hash) && !unique.has(title.hash) && (unique.add(title.hash), true));
      if (!missing.length || (!drain && batch === MAX_PER_QUERY / BATCH)) {
        for (const title of live) put.run(title.sessionId, title.title, title.hash);
        return { remaining: missing.length, indexed: 0 };
      }
      const targets = missing.slice(0, BATCH);
      await requireSemanticIdentity(options, config, owned);
      if (eligible && !(await Promise.all(candidates.filter(c=>targets.some(t=>t.nativeId===c.id)).map(c=>eligible(c,owned)))).every(Boolean)) return {remaining:missing.length,indexed:0};
      let vectors;
      try {
        vectors = await db.outside(() => withProviderSlot(owned, async () => {
          await requireSourceEnabled(root, "sessions", owned);
          if (eligible && !(await Promise.all(candidates.filter(c=>targets.some(t=>t.nativeId===c.id)).map(c=>eligible(c,owned)))).every(Boolean)) throw new SessionIndexDeferred();
          return (options.embedTasks ?? embedTaskTexts)(targets.map(item => item.title), key, owned, config);
        }));
      } catch (error) {
        if (!(error instanceof SessionIndexDeferred)) throw error;
        return {remaining:missing.length,indexed:0};
      }
      owned.throwIfAborted();
      await requireSourceEnabled(root, "sessions", owned);
      await requireSemanticIdentity(options, config, owned);
      if (eligible && !(await Promise.all(candidates.filter(c=>targets.some(t=>t.nativeId===c.id)).map(c=>eligible(c,owned)))).every(Boolean)) return {remaining:missing.length,indexed:0};
      if (vectors.length !== targets.length || !vectors.every(v => validSearchVector(v, config.dimension))) throw new Error("Invalid session title embedding batch");
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
      await requireSemanticIdentity(options, config, owned);
      const add = db.prepare("INSERT INTO pix_session_vectors(title_hash,vector) VALUES(?,?) ON CONFLICT(title_hash) DO NOTHING");
      await requireSourceEnabled(root, "sessions", owned);
      if (eligible && !(await Promise.all(candidates.filter(c=>targets.some(t=>t.nativeId===c.id)).map(c=>eligible(c,owned)))).every(Boolean)) return {remaining:missing.length,indexed:0};
      for (const title of live) put.run(title.sessionId, title.title, title.hash);
      for (let i = 0; i < targets.length; i++) {
        const bytes = Buffer.alloc(config.dimension * 4);
        vectors[i]!.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
        add.run(targets[i]!.hash, bytes);
      }
      return { remaining: missing.length - targets.length, indexed: targets.length };
    }, "sessions", retry && batch === 0);
    indexed += response.indexed;
    remaining = response.remaining;
    if (!remaining || !response.indexed) break;
  }
  return { remaining, indexed };
}
import { requireSourceEnabled } from "./source-policy.mjs";
