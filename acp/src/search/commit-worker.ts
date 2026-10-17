import { parentPort, workerData } from "node:worker_threads";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalSearchIndexPath } from "./canonical-index.js";
import { claimWork } from "./source-work.js";
import {
  COMMIT_DOCUMENTS, COMMIT_META, COMMIT_VECTORS, createCommitTables,
} from "./commit-storage.js";
import { setTimeout as delay } from "node:timers/promises";
import { commitHead, patchSearchTerm, rankCommits, readCommitCorpus, readPatchMatches } from "./commit-corpus.js";
import { embeddingIdentity, SEMANTIC_NOTICE, validCommitVector, type CommitEmbeddingConfig } from "./commit-provider.js";
import type { CommitSearchRequest } from "./commit-contract.js";
import type { SearchIndexRequest } from "./contract.js";
import { commitStamp } from "./commit-stamp.js";
import { COVERAGE_KEEP, coverageDigest, recordCoverage } from "./source-coverage.js";

const port = parentPort!;
const data = workerData as { request: CommitSearchRequest | SearchIndexRequest; root: string; config?: CommitEmbeddingConfig; lockWaitMs: number };
const indexOnly = "source" in data.request;
const controller = new AbortController(); const signal = controller.signal;
let serial = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
port.on("message", p => {
  if (p.type === "abort") { controller.abort(); return; }
  const waiter = pending.get(p.id); if (!waiter) return; pending.delete(p.id);
  if (p.ok) waiter.resolve(p.value); else waiter.reject(new Error(SEMANTIC_NOTICE));
});
function rpc(type: "embed" | "validate", input?: string[], query = false): Promise<unknown> {
  signal.throwIfAborted(); const id = ++serial;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); port.postMessage({ type, id, input, query }); });
}
async function lock(db: DatabaseSync): Promise<void> {
  const until = Date.now() + data.lockWaitMs;
  while (true) {
    signal.throwIfAborted();
    try { db.exec("BEGIN IMMEDIATE"); return; }
    catch (e) {
      if (!(e instanceof Error) || !/locked|busy/i.test(e.message) || Date.now() >= until) throw new Error("Commit index busy; local BM25 results remain available.");
      await delay(25, undefined, { signal });
    }
  }
}
async function embed(input: string[], c: CommitEmbeddingConfig, query = false): Promise<number[][]> {
  const values = await rpc("embed", input, query); signal.throwIfAborted();
  if (!Array.isArray(values) || values.length !== input.length || !values.every(v => validCommitVector(v, c.dimension))) throw new Error(SEMANTIC_NOTICE);
  if (!(await rpc("validate"))) throw new Error(SEMANTIC_NOTICE);
  signal.throwIfAborted(); return values as number[][];
}
async function commitIndexPath(root: string): Promise<string> {
  // Validate each ancestor before creating children in a potentially redirected directory.
  for (const directory of [join(root, ".pi"), join(root, ".pi", "search")]) {
    await mkdir(directory, { mode: 0o700 }).catch(error => {
      if (error.code !== "EEXIST") throw error;
    });
    const entry = await lstat(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(SEMANTIC_NOTICE);
  }
  const file = canonicalSearchIndexPath(root, "commits");
  for (const candidate of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    const entry = await lstat(candidate).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (entry && (entry.isSymbolicLink() || !entry.isFile())) throw new Error(SEMANTIC_NOTICE);
  }
  const handle = await open(file, "wx", 0o600).catch(error => {
    if (error.code !== "EEXIST") throw error;
    return undefined;
  });
  await handle?.close();
  return file;
}
async function run() {
  let head: string | undefined;
  let docs;
  // Logical revision observed by the native probe; coverage requires it unchanged.
  let stampBefore: string | undefined;
  if (indexOnly) { try { stampBefore = JSON.stringify(await commitStamp(data.root, signal)); } catch { signal.throwIfAborted(); } }
  try { head = await commitHead(data.root, signal); docs = await readCommitCorpus(data.root, signal); }
  catch { signal.throwIfAborted(); return indexOnly ? { source: "commits", complete: false, failurePhase: "history", message: "Commit history unavailable (repository may have no HEAD)." }
    : { results: [], notices: ["Commit history unavailable (repository may have no HEAD)."] }; }
  const patchTerm = "query" in data.request ? patchSearchTerm(data.request.query) : undefined;
  if (patchTerm && "query" in data.request) {
    try {
      const matches = new Set(await readPatchMatches(data.root, patchTerm, signal));
      signal.throwIfAborted();
      return { results: docs.filter(doc => matches.has(doc.commit.hash)).slice(0, data.request.limit).map(doc => ({
        kind: "commits" as const, id: `commits:${doc.commit.hash}`, hash: doc.commit.hash,
        title: doc.commit.subject, snippet: `Patch match · ${doc.commit.shortHash}${doc.commit.changedPaths?.length ? `\n${doc.commit.changedPaths.slice(0, 3).join(" · ")}` : ""}`,
        score: 1, commit: doc.commit, contentMatch: true,
      })), notices: [] };
    } catch {
      signal.throwIfAborted();
      return { results: [], notices: ["Git patch search unavailable or exceeded its 8-second limit."] };
    }
  }
  const vectors = new Map<string, number[]>(); const notices: string[] = [];
  let queryVector: number[] | undefined;
  let failurePhase: "configuration" | "authorization" | "storage" | "provider" | "history" | undefined;
  let phase: NonNullable<typeof failurePhase> = "storage";
  if (data.config && docs.length) {
    let db: DatabaseSync | undefined;
    try {
      const c = data.config; const identity = embeddingIdentity(c);
      db = new DatabaseSync(await commitIndexPath(data.root));
      db.exec("PRAGMA busy_timeout=0");
      await lock(db);
      try {
        createCommitTables(db);
        if (indexOnly) db.exec("CREATE TEMP TABLE pix_live_commit_ids (hash TEXT PRIMARY KEY)");
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      for (let offset = 0; offset < docs.length; offset += 16) {
        signal.throwIfAborted();
        phase = "storage";
        const work = await claimWork(db, signal, { retry: indexOnly && offset === 0 });
        let writing = false, success = false;
        try {
          await lock(db); writing = true;
          phase = "authorization";
          if (!(await rpc("validate"))) throw new Error(SEMANTIC_NOTICE);
          phase = "storage";
          const saved = db.prepare(`SELECT value FROM ${COMMIT_META} WHERE key='identity'`).get()?.value;
          if (saved !== undefined && (typeof saved !== "string" || JSON.parse(saved)[0] !== 1)) throw new Error(SEMANTIC_NOTICE);
          const same = saved === identity;
          if (saved !== undefined && !same) throw new Error(SEMANTIC_NOTICE);
          const batch = docs.slice(offset, offset + 16);
          const purchased = new Map<string, number[]>();
          const missing = batch.filter(d => {
            const row = same ? db!.prepare(`SELECT vector FROM ${COMMIT_VECTORS} WHERE hash=?`).get(d.contentHash) : undefined;
            if (row) {
              const v = JSON.parse(String(row.vector));
              if (validCommitVector(v, c.dimension)) { vectors.set(d.contentHash, v); return false; }
            }
            return true;
          });
          // Never destructively reinterpret purchased vectors under another identity.
          const selected = missing;
          if (selected.length) work.network(db);
          db.exec("COMMIT"); writing = false;
          phase = "provider";
          const embedded = selected.length ? await embed(selected.map(d => (c.documentPrefix + d.commit.subject + "\n" + d.commit.author + "\n" + d.message).slice(0, 8192)), c) : [];
          phase = "history";
          if (head !== await commitHead(data.root, signal)) throw new Error("Commit history changed during indexing");
          phase = "storage";
          await lock(db); writing = true; work.assert(db);
          if (!(await rpc("validate"))) throw new Error(SEMANTIC_NOTICE);
          signal.throwIfAborted();
          if (!same) db.prepare(`INSERT INTO ${COMMIT_META} VALUES ('identity',?)`).run(identity);
          for (let i = 0; i < selected.length; i++) {
            const d = selected[i]!; const v = embedded[i]!; purchased.set(d.contentHash, v);
            db.prepare(`INSERT OR REPLACE INTO ${COMMIT_VECTORS} VALUES (?,?)`).run(d.contentHash, JSON.stringify(v));
          }
          for (const d of batch) db.prepare(`INSERT INTO ${COMMIT_DOCUMENTS} VALUES (?,?,?,?) ON CONFLICT(hash) DO UPDATE SET content_hash=excluded.content_hash, metadata=excluded.metadata, message=excluded.message WHERE ${COMMIT_DOCUMENTS}.content_hash!=excluded.content_hash OR ${COMMIT_DOCUMENTS}.metadata!=excluded.metadata OR ${COMMIT_DOCUMENTS}.message!=excluded.message`).run(d.commit.hash, d.contentHash, JSON.stringify(d.commit), d.message);
          if (indexOnly) for (const d of batch) db.prepare("INSERT OR IGNORE INTO pix_live_commit_ids VALUES (?)").run(d.commit.hash);
          db.exec("COMMIT"); writing = false; success = true;
          for (const [hash, vector] of purchased) vectors.set(hash, vector);
        } finally {
          if (writing) { try { db.exec("ROLLBACK"); } catch {} }
          try { await work.release(success); } catch { /* Lease expiry recovers after a crash. */ }
        }
        await delay(0, undefined, { signal });
      }
      if (indexOnly && docs.length) {
        phase = "storage";
        await lock(db);
        try {
          if (!(await rpc("validate"))) throw new Error(SEMANTIC_NOTICE);
          if (head !== await commitHead(data.root, signal)) throw new Error(SEMANTIC_NOTICE);
          db.exec(`DELETE FROM ${COMMIT_DOCUMENTS} WHERE hash NOT IN (SELECT hash FROM pix_live_commit_ids)`);
          if (stampBefore && docs.every(doc => vectors.has(doc.contentHash))) {
            let stampAfter: string | undefined;
            try { stampAfter = JSON.stringify(await commitStamp(data.root, signal)); } catch { signal.throwIfAborted(); }
            if (stampAfter === stampBefore) recordCoverage(db, coverageDigest("commits", JSON.parse(stampBefore), embeddingIdentity(c)), COVERAGE_KEEP.commits);
          }
          signal.throwIfAborted(); db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      }
      if ("query" in data.request) queryVector = (await embed([(c.queryPrefix + data.request.query).slice(0, 8192)], c, true))[0];
    } catch (e) {
      signal.throwIfAborted();
      if (indexOnly) failurePhase = phase;
      notices.push(e instanceof Error && e.message === "Commit index busy; local BM25 results remain available." ? e.message : SEMANTIC_NOTICE);
    } finally { db?.close(); }
  } else if (!data.config) { notices.push(SEMANTIC_NOTICE); if (indexOnly) failurePhase = "configuration"; }
  if (queryVector) {
    try { if (!(await rpc("validate"))) throw new Error(SEMANTIC_NOTICE); }
    catch { signal.throwIfAborted(); queryVector = undefined; notices.push(SEMANTIC_NOTICE); }
  }
  signal.throwIfAborted();
  if (indexOnly) {
    try {
      if (!(await rpc("validate"))) throw new Error(SEMANTIC_NOTICE);
      if (head !== await commitHead(data.root, signal)) {
        notices.push("Commit history changed; retry indexing this source"); failurePhase ??= "history";
      }
    } catch { signal.throwIfAborted(); notices.push(SEMANTIC_NOTICE); failurePhase ??= "authorization"; }
    const indexed = docs.filter(doc => vectors.has(doc.contentHash)).length;
    return { source: "commits", complete: notices.length === 0 && indexed === docs.length, indexed, total: docs.length,
      ...(failurePhase ? { failurePhase } : {}),
      ...(notices.length ? { message: notices[0] } : indexed < docs.length ? { message: "Indexing pass finished; continue to index remaining documents" } : {}) };
  }
  if (!("query" in data.request)) throw new Error("Invalid commit request");
  return { results: rankCommits(docs, data.request.query, data.request.limit, vectors, queryVector), notices };
}
run().then(value => port.postMessage({ type: "result", value }), () => port.postMessage({ type: "failed" })).finally(() => port.close());
