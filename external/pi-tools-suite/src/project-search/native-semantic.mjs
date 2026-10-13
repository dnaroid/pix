import { chunkHit, checkStorage } from "./native-store.mjs";
import { openVectorStore } from "./native-vector-store.mjs";
import { beginWrite, withProviderSlot } from "./source-work.mjs";
import { readSafeFile } from "./native-scan.mjs";
import { readSourceExtensions, sourceKind } from "./native-source-config.mjs";
import { digest, repositoryEmbeddingSettings, repositoryEmbeddingKey, embedRepository } from "./native-embedding-provider.mjs";
import { preferDistinctFiles, prioritizeIdentifiers } from "./native-ranking.mjs";

export const MAX_CHUNKS_PER_SEARCH = 128;
// Filter raw similarity before test penalties and reciprocal-rank fusion.
export const MIN_REPOSITORY_SIMILARITY = 0.25;
function cosine(a, b) {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return dot / Math.sqrt(aa * bb);
}
function scopedChunks(store, request) {
  const where = [`kind IN (${request.sources.map(() => "?").join(",")})`], params = [...request.sources];
  if (request.pathPrefix) {
    where.push("(path=? OR substr(path,1,?)=?)");
    params.push(request.pathPrefix, request.pathPrefix.length + 1, request.pathPrefix + "/");
  }
  if (request.excludeTests) where.push("is_test=0");
  const rows = store.db.prepare(`SELECT * FROM pix_native_chunks WHERE ${where.join(" AND ")} ORDER BY path,start_line LIMIT 20001`).all(...params);
  if (rows.length > 20000) throw new Error("Native chunk cap");
  return rows.map(row => {
    chunkHit(row, 0, request);
    const text = `${row.path}\n${row.title}\n${row.content}`.slice(0, 8192);
    return { row, text, digest: digest("document\0" + text) };
  });
}
export function fuseRepositoryHits(lexical, semantic, request) {
  const merged = new Map();
  for (const list of [lexical, semantic]) list.forEach((hit, rank) => {
    const previous = merged.get(hit.id);
    merged.set(hit.id, { ...hit, score: (previous?.score ?? 0) + 30 / (60 + rank + 1) });
  });
  const seen = new Set();
  return prioritizeIdentifiers(preferDistinctFiles([...merged.values()].sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.startLine - b.startLine))), request.query)
    .filter(hit => { if (request.dedupeFile && seen.has(hit.path)) return false; seen.add(hit.path); return true; }).slice(0, request.limit);
}

/** On-demand, bounded semantic enrichment. Missing/off/provider failures cannot break FTS.
 * Dependencies are an in-process test seam, never selectable through CLI/tool requests. */
export async function searchSemantic(store, request, generation, dependencies = {}) {
  return semanticPass(store, request, generation, dependencies, false);
}

/** Uses the same scoped chunks, leases and publication checks without query work. */
export async function indexSemantic(store, source, generation, dependencies = {}) {
  return semanticPass(store, { sources: [source] }, generation, dependencies, true);
}

async function semanticPass(store, request, generation, dependencies, documentOnly) {
  const settings = await repositoryEmbeddingSettings(store.root);
  if (!settings) return { hits: [], notices: documentOnly || request.mode === "semantic" ? ["Native semantics is off or its saved provider configuration is unavailable."] : [],
    status: { enabled: false, complete: false, state: "disabled" } };
  const caller = dependencies.signal ?? new AbortController().signal;
  const signal = documentOnly ? caller : AbortSignal.any([caller, AbortSignal.timeout(22000)]);
  const started = Date.now(), notices = [], hits = [];
  let vectors, activeLease, indexed = 0, total = 0, uploaded = 0;
  const current = async () => {
    signal.throwIfAborted();
    await requireSourceEnabled(store.root, store.source, signal);
    await checkStorage(store.root, store.filename);
    if (vectors) await checkStorage(store.root, vectors.filename);
    if ((await repositoryEmbeddingSettings(store.root))?.signature !== settings.signature
      || store.db.prepare("SELECT generation FROM pix_native_meta WHERE singleton=1").get().generation !== generation) throw new Error("Search context changed");
    signal.throwIfAborted();
    if (activeLease) vectors.renew(activeLease.identity, activeLease.token);
  };
  const publication = db => {
    dependencies.work?.assert(db);
    if (db.prepare("SELECT generation FROM pix_native_meta WHERE singleton=1").get()?.generation !== generation) throw new Error("Native index changed before publication");
  };
  const currentDocuments = async batch => {
    const extensions = await readSourceExtensions();
    for (const name of new Set(batch.map(item => item.row.path))) {
      const file = await readSafeFile(store.root, name);
      const kind = sourceKind(name, extensions);
      const expected = store.db.prepare("SELECT hash FROM pix_native_files WHERE path=?").get(name)?.hash;
      if (kind !== store.source || digest(`${kind}:${file.hash}`) !== expected) throw new Error("Native content changed during embedding");
    }
  };
  const embed = async (inputs, config, key) => {
    await current();
    const controller = new AbortController();
    let checking = false, closed = false;
    const timer = setInterval(() => {
      if (checking || closed) return;
      checking = true;
      void current().catch(() => { if (!closed) controller.abort(); }).finally(() => { checking = false; });
    }, 200);
    try {
      const request = () => withProviderSlot(signal, async () => {
        await current();
        if (dependencies.work) {
          await beginWrite(store.db, signal);
          try { dependencies.work.network(store.db); store.db.exec("COMMIT"); }
          catch (error) { store.db.exec("ROLLBACK"); throw error; }
        }
        return (dependencies.embed ?? embedRepository)(inputs, config, key, AbortSignal.any([signal, controller.signal]));
      });
      const result = await (dependencies.work ? dependencies.work.run(request) : request());
      await current();
      controller.signal.throwIfAborted();
      return result;
    } finally { closed = true; clearInterval(timer); controller.abort(); }
  };
  try {
    await current();
    const chunks = scopedChunks(store, request);
    total = chunks.length;
    if (!total) return { hits, notices, status: { enabled: true, complete: true, state: "ready", indexed: 0, total: 0 } };
    vectors = await openVectorStore(store.root, store.source, signal);
    const key = await (dependencies.key ?? repositoryEmbeddingKey)();
    const activeKinds = request.sources.filter(kind => chunks.some(chunk => chunk.row.kind === kind));
    const limit = documentOnly ? Infinity : MAX_CHUNKS_PER_SEARCH;
    const domainBudget = Math.floor(limit / activeKinds.length);
    const uploadBudget = documentOnly ? { remaining: Infinity } : dependencies.uploadBudget ?? { remaining: limit };
    for (const kind of request.sources) {
      await current();
      const config = settings.configs[kind], selected = chunks.filter(chunk => chunk.row.kind === kind);
      if (!selected.length) continue;
      const queryText = documentOnly ? undefined : config.queryPrefix + request.query;
      const queryDigest = documentOnly ? undefined : digest("query\0" + queryText);
      let queryVector = documentOnly ? undefined : vectors.get(config.identity, queryDigest, config.dimension);
      const missing = selected.filter(chunk => !vectors.get(config.identity, chunk.digest, config.dimension));
      const canEmbed = config.provider !== "openrouter" || Boolean(key);
      let token;
      try {
        if (canEmbed && ((!documentOnly && !queryVector) || missing.length) && (documentOnly || Date.now() - started < 18000)) token = vectors.acquire(config.identity);
        if (token) {
          activeLease = { identity: config.identity, token };
          if (!documentOnly && !queryVector) {
            [queryVector] = await embed([queryText], config, key);
            vectors.put(config.identity, token, [{ digest: queryDigest, vector: queryVector }], config.dimension, publication);
          }
          for (let offset = 0; offset < missing.length && offset < domainBudget && uploaded < limit && (documentOnly || Date.now() - started < 18000); offset += 16) {
            const count = Math.min(16, missing.length - offset, domainBudget - offset, limit - uploaded, uploadBudget.remaining);
            if (count <= 0) break;
            // Reserve synchronously before either source can await HTTP or file validation.
            uploadBudget.remaining -= count;
            const batch = missing.slice(offset, offset + count);
            await currentDocuments(batch);
            const result = await embed(batch.map(chunk => config.documentPrefix + chunk.text), config, key);
            await currentDocuments(batch);
            await current();
            if (result.length !== batch.length) throw new Error("Embedding count mismatch");
            vectors.put(config.identity, token, batch.map((chunk, i) => ({ digest: chunk.digest, vector: result[i] })), config.dimension, publication);
            uploaded += batch.length;
          }
        }
      } finally { activeLease = undefined; if (token) vectors.release(config.identity, token); }
      for (const chunk of selected) {
        signal.throwIfAborted();
        const vector = vectors.get(config.identity, chunk.digest, config.dimension);
        if (!vector) continue;
        indexed++;
        if (documentOnly || !queryVector) continue;
        const similarity = cosine(queryVector, vector);
        if (!(similarity >= MIN_REPOSITORY_SIMILARITY)) continue;
        const score = similarity * (!request.includeTests && chunk.row.is_test ? 0.6 : 1);
        hits.push(chunkHit(chunk.row, score, request));
      }
      if (!documentOnly && !queryVector) notices.push("Semantic query embedding unavailable or another indexer is active; local results remain available.");
    }
    await current();
    const complete = indexed === total && !notices.length;
    if (!complete) notices.push(documentOnly
      ? `Native semantic coverage: ${indexed}/${total} scoped chunks. Check provider credentials or an active indexer, then retry; cached embeddings are retained.`
      : `Native semantic coverage: ${indexed}/${total} scoped chunks. Indexes up to 128 new chunks per search; search again to continue (requires configured provider credentials).`);
    hits.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.startLine - b.startLine));
    return { hits: hits.slice(0, 200), notices, status: { enabled: true, complete, state: complete ? "ready" : "partial", indexed, total } };
  } catch {
    return { hits: [], notices: [documentOnly
      ? "Native indexing unavailable, cancelled or context changed; cached embeddings are retained. Retry to verify current coverage."
      : "Native semantic search unavailable, cancelled or context changed; local results remain available."],
      status: { enabled: true, complete: false, state: "unavailable", indexed, total } };
  } finally { vectors?.close(); }
}
import { requireSourceEnabled } from "./source-policy.mjs";
