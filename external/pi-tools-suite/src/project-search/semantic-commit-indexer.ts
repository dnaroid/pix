import { createHash } from "node:crypto";
import type { CommitRecord, ProjectSearchHit } from "./engine.js";
import { commitIdentity, embedCommits, loadCommitConfig, loadCommitKey, validCommitVector,
  type CommitEmbeddingConfig } from "./semantic-commit-provider.js";
import { withSearchIndexWriter, type SqlDatabase } from "./semantic-index-writer.js";

const MAX_NEW_COMMIT_VECTORS = 256;
const BATCH = 16;
const DEADLINE_MS = 40_000;

export interface CommitSemanticServices {
  loadConfig?: (root: string) => Promise<CommitEmbeddingConfig | undefined>;
  loadKey?: () => Promise<string | undefined>;
  embed?: (input: readonly string[], config: CommitEmbeddingConfig, key: string | undefined, signal: AbortSignal) => Promise<readonly (readonly number[])[]>;
}

interface CommitSemanticDocument {
  record: CommitRecord;
  contentHash: string;
}

function candidate(record: CommitRecord): CommitSemanticDocument {
  const base = { hash: record.hash, shortHash: record.shortHash, subject: record.title, author: record.author, date: record.date };
  return { record, contentHash: createHash("sha256").update(JSON.stringify([base, record.message])).digest("hex") };
}

function ensureCommitSchema(db: SqlDatabase, config: CommitEmbeddingConfig): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pix_commit_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pix_commit_vectors(hash TEXT PRIMARY KEY,vector TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pix_commit_documents(hash TEXT PRIMARY KEY,content_hash TEXT NOT NULL,metadata TEXT NOT NULL,message TEXT NOT NULL)`);
  const identity = db.prepare("SELECT value FROM pix_commit_meta WHERE key='identity'").get()?.value;
  if (identity !== undefined && identity !== commitIdentity(config)) {
    // Do not silently discard already paid vectors from another IDX model.
    throw new Error("Commit embedding identity has changed");
  }
}

function cachedVectors(db: SqlDatabase, docs: readonly CommitSemanticDocument[], config: CommitEmbeddingConfig): {
  present: Map<string, number[]>; missing: CommitSemanticDocument[];
} {
  const get = db.prepare("SELECT vector FROM pix_commit_vectors WHERE hash=?");
  const present = new Map<string, number[]>();
  const missing: CommitSemanticDocument[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    if (seen.has(doc.contentHash)) continue;
    seen.add(doc.contentHash);
    const encoded = get.get(doc.contentHash)?.vector;
    if (typeof encoded !== "string") { missing.push(doc); continue; }
    let vector: unknown;
    try { vector = JSON.parse(encoded); } catch { /* Invalid cache entry is missing. */ }
    if (validCommitVector(vector, config.dimension)) present.set(doc.contentHash, vector);
    else missing.push(doc);
  }
  return { present, missing };
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0, xx = 0, yy = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    dot += x * y; xx += x * x; yy += y * y;
  }
  const value = dot / Math.sqrt(xx * yy);
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

/** Git commits are immutable; current HEAD is checked after every paid batch
 * and again before publishing results. The persisted documents use Desktop's
 * existing pix_commit_* schema, model identity and content-hash projection. */
export async function searchSemanticCommits(root: string, records: readonly CommitRecord[], query: string,
  readHead: (signal: AbortSignal) => Promise<string>, signal: AbortSignal,
  services: CommitSemanticServices = {}): Promise<{ hits: ProjectSearchHit[]; notices: string[] }> {
  if (!records.length) return { hits: [], notices: [] };
  const notices: string[] = [];
  let config: CommitEmbeddingConfig | undefined;
  try { config = await (services.loadConfig ?? loadCommitConfig)(root); }
  catch { /* Local Git fallback. */ }
  if (!config) return { hits: [], notices: [] };
  let key: string | undefined;
  if (config.provider === "openrouter") {
    try { key = await (services.loadKey ?? loadCommitKey)(); } catch { /* Local Git fallback. */ }
    if (!key) return { hits: [], notices: ["Semantic commits need a configured IDX OpenRouter credential; local Git results remain available."] };
  }
  const owned = AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS)]);
  const head = records[0]!.hash;
  const headNow = await readHead(owned);
  if (headNow.trim() !== head) return { hits: [], notices: ["Commit HEAD changed; retry to search the latest history."] };
  const docs = records.map(candidate);
  let indexed = 0, remaining = 0;
  try {
    for (let batch = 0; batch <= MAX_NEW_COMMIT_VECTORS / BATCH; batch++) {
      owned.throwIfAborted();
      const result = await withSearchIndexWriter(root, owned, async db => {
        ensureCommitSchema(db, config!);
        const { missing } = cachedVectors(db, docs, config!);
        if (!missing.length || batch === MAX_NEW_COMMIT_VECTORS / BATCH) return { indexed: 0, remaining: missing.length };
        const targets = missing.slice(0, BATCH);
        if ((await readHead(owned)).trim() !== head) throw new Error("Commit HEAD changed during indexing");
        const input = targets.map(doc => (config!.documentPrefix + doc.record.title + "\n" + doc.record.author + "\n" + doc.record.message).slice(0, 8192));
        const vectors = await (services.embed ?? embedCommits)(input, config!, key, owned);
        owned.throwIfAborted();
        if (vectors.length !== targets.length || !vectors.every(v => validCommitVector(v, config!.dimension))) {
          throw new Error("Invalid commit embedding result");
        }
        const current = await (services.loadConfig ?? loadCommitConfig)(root);
        if (!current || commitIdentity(current) !== commitIdentity(config!) || (await readHead(owned)).trim() !== head) {
          throw new Error("Commit configuration or HEAD changed during indexing");
        }
        const add = db.prepare("INSERT INTO pix_commit_vectors(hash,vector) VALUES(?,?) ON CONFLICT(hash) DO UPDATE SET vector=excluded.vector");
        for (let i = 0; i < targets.length; i++) add.run(targets[i]!.contentHash, JSON.stringify(vectors[i]));
        const put = db.prepare(`INSERT INTO pix_commit_documents(hash,content_hash,metadata,message) VALUES(?,?,?,?)
          ON CONFLICT(hash) DO UPDATE SET content_hash=excluded.content_hash,metadata=excluded.metadata,message=excluded.message
          WHERE pix_commit_documents.content_hash!=excluded.content_hash OR pix_commit_documents.metadata!=excluded.metadata OR pix_commit_documents.message!=excluded.message`);
        for (const target of targets) {
          const item = target.record;
          put.run(item.hash, target.contentHash, JSON.stringify({ hash: item.hash, shortHash: item.shortHash,
            subject: item.title, author: item.author, date: item.date, changedPaths: item.paths }), item.message);
        }
        db.prepare("INSERT INTO pix_commit_meta(key,value) VALUES('identity',?) ON CONFLICT(key) DO NOTHING").run(commitIdentity(config!));
        return { indexed: targets.length, remaining: missing.length - targets.length };
      });
      indexed += result.indexed;
      remaining = result.remaining;
      if (!remaining || !result.indexed) break;
    }
  } catch (error) {
    signal.throwIfAborted();
    notices.push("Semantic commit indexing unavailable or interrupted; local Git matches remain available.");
  }
  if (remaining) notices.push(`Semantic Commits: ${remaining} commits remain to index; another search continues the index.`);

  const saved = await withSearchIndexWriter(root, owned, async db => {
    ensureCommitSchema(db, config!);
    return cachedVectors(db, docs, config!).present;
  }).catch(() => new Map<string, number[]>());
  if (!saved.size || (await readHead(owned)).trim() !== head) return { hits: [], notices };
  const current = await (services.loadConfig ?? loadCommitConfig)(root);
  if (!current || commitIdentity(current) !== commitIdentity(config)) return { hits: [], notices };
  let queryVector: readonly number[];
  try {
    const vectors = await (services.embed ?? embedCommits)([(config.queryPrefix + query).slice(0, 8192)], config, key, owned);
    if (vectors.length !== 1 || !validCommitVector(vectors[0], config.dimension)) throw new Error("Invalid commit query embedding");
    queryVector = vectors[0]!;
  } catch (error) {
    signal.throwIfAborted();
    notices.push("Semantic commit query unavailable; local Git matches remain available.");
    return { hits: [], notices };
  }
  // IDX may have switched embedding model/provider while the query vector
  // was in flight. Never combine a late old-model query with the new config.
  const afterQueryConfig = await (services.loadConfig ?? loadCommitConfig)(root);
  if (!afterQueryConfig || commitIdentity(afterQueryConfig) !== commitIdentity(config)) {
    return { hits: [], notices: [...notices, "Commit embedding configuration changed; search again."] };
  }
  if ((await readHead(owned)).trim() !== head) return { hits: [], notices: [...notices, "Commit HEAD changed; retry with current history."] };
  const hits: ProjectSearchHit[] = [];
  for (const doc of docs) {
    const vector = saved.get(doc.contentHash);
    if (!vector) continue;
    const similarity = cosine(queryVector, vector);
    if (similarity < 0.25) continue;
    const item = doc.record;
    hits.push({ kind: "commits", id: `commits:${item.hash}`, hash: item.hash, title: item.title,
      snippet: `${item.shortHash} · ${item.author} · ${item.date} · ${item.message.slice(0, 240)}`,
      changedPaths: item.paths.slice(0, 64), score: 0.2 + similarity * 0.8, semantic: true });
  }
  return { hits, notices };
}
