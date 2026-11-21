import { resolve } from "node:path";
import { setImmediate as yieldTask } from "node:timers/promises";
import { beginWrite, claimWork } from "./source-work.mjs";
import { storage, valid, decode, INDEX_META, RANGES, SESSION_CHUNK_FORMAT } from "./session-chunk-store.mjs";
export { listIndexedSessions, searchSessionChunks, hasSessionChunkVectors } from "./session-chunk-query.mjs";
import { readSessionTranscript, transcriptUnchanged } from "./session-transcript.mjs";
import { logSearchDiagnostic } from "./search-logging.mjs";
import { sessionIndexProgress } from "./session-index-progress.mjs";
import { SessionIndexDeferred } from "./session-idle.mjs";
import { ensureSessionRevision } from "./session-index-revision.mjs";

const DOCUMENTS = "pix_session_chunks";
const VECTORS = "pix_session_chunk_vectors";
const META = "pix_session_chunk_meta";
const FTS = "pix_session_chunk_fts";
function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${META}(session_id TEXT PRIMARY KEY,path TEXT NOT NULL,revision TEXT NOT NULL,head TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ${DOCUMENTS}(session_id TEXT NOT NULL,message_id TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL,text TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(session_id,message_id,start));
    CREATE INDEX IF NOT EXISTS pix_session_chunk_hash ON ${DOCUMENTS}(hash);
    CREATE TABLE IF NOT EXISTS ${VECTORS}(identity TEXT NOT NULL,hash TEXT NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(identity,hash));
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS} USING fts5(session_id UNINDEXED,message_id UNINDEXED,start UNINDEXED,text,tokenize='unicode61');
    CREATE TABLE IF NOT EXISTS ${INDEX_META}(session_id TEXT PRIMARY KEY,cwd TEXT NOT NULL,path TEXT NOT NULL,
      file_stamp TEXT NOT NULL,revision TEXT NOT NULL,head TEXT NOT NULL,format TEXT NOT NULL,title TEXT NOT NULL,name TEXT NOT NULL,first_message TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ${RANGES}(session_id TEXT NOT NULL,message_id TEXT NOT NULL,start INTEGER NOT NULL,
      byte_offset INTEGER NOT NULL,byte_length INTEGER NOT NULL,snippet TEXT NOT NULL,active INTEGER NOT NULL CHECK(active=1),
      PRIMARY KEY(session_id,message_id,start));`);
  ensureSessionRevision(db);
}
/** Rows per rebuild transaction: bounds how long a peer host waits for the write lock. */
export const RECONCILE_BATCH = 256;
const DELETE_BATCH = 1024;
/** BEGIN..COMMIT runs synchronously: the write lock is never held across an await. */
async function writeTransaction(db, signal, write) {
  await beginWrite(db, signal);
  try {
    const result = write();
    if (typeof result?.then === "function") throw new TypeError("Session index write transactions must be synchronous");
    db.exec("COMMIT");
    return result;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
/** Rebuild one session in bounded transactions under the documents lease, which
 * every writer of this cache holds and each batch asserts. Readers find sessions
 * only through INDEX_META, unpublished first and published last, so a partial
 * rebuild is never searchable (a stale entry was already hidden by its file stamp).
 * `publishable` runs between transactions; false leaves the session unpublished. */
async function reconcile(db, snapshot, signal, work, publishable) {
  const id = snapshot.id;
  const saved = db.prepare(`SELECT * FROM ${INDEX_META} WHERE session_id=?`).get(id);
  if (saved?.revision === snapshot.revision && saved?.file_stamp === snapshot.fileStamp && saved?.format === SESSION_CHUNK_FORMAT
    && saved.path === snapshot.path && saved.cwd === snapshot.cwd) return publishable();
  await writeTransaction(db, signal, () => { work.assert(db); db.prepare(`DELETE FROM ${INDEX_META} WHERE session_id=?`).run(id); });
  for (const table of [DOCUMENTS, FTS, RANGES]) {
    const rowids = db.prepare(`SELECT rowid FROM ${table} WHERE session_id=?`).all(id).map(row => row.rowid);
    for (let i = 0; i < rowids.length; i += DELETE_BATCH) {
      await writeTransaction(db, signal, () => {
        work.assert(db);
        const remove = db.prepare(`DELETE FROM ${table} WHERE rowid=?`);
        for (const rowid of rowids.slice(i, i + DELETE_BATCH)) remove.run(rowid);
      });
      await yieldTask();
    }
  }
  for (let i = 0; i < snapshot.chunks.length; i += RECONCILE_BATCH) {
    await writeTransaction(db, signal, () => {
      work.assert(db);
      const insert = db.prepare(`INSERT INTO ${DOCUMENTS} VALUES(?,?,?,?,?,?,?,?,?)`);
      const fts = db.prepare(`INSERT INTO ${FTS} VALUES(?,?,?,?)`);
      const ranges = db.prepare(`INSERT INTO ${RANGES} VALUES(?,?,?,?,?,?,1)`);
      for (const c of snapshot.chunks.slice(i, i + RECONCILE_BATCH)) {
        signal.throwIfAborted();
        insert.run(id,c.messageId,c.start,c.end,c.ordinal,c.role,c.status,c.text,c.hash);
        fts.run(id,c.messageId,c.start,c.text);
        ranges.run(id,c.messageId,c.start,c.byteOffset,c.byteLength,c.text.replace(/\s+/gu," ").slice(0,1200));
      }
    });
    await yieldTask();
  }
  if (!await publishable()) return false;
  await writeTransaction(db, signal, () => {
    work.assert(db);
    db.prepare(`INSERT OR REPLACE INTO ${INDEX_META} VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,snapshot.cwd,snapshot.path,
      snapshot.fileStamp,snapshot.revision,snapshot.head,SESSION_CHUNK_FORMAT,snapshot.title,snapshot.name,snapshot.firstMessage);
    db.prepare(`INSERT INTO ${META} VALUES(?,?,?,?) ON CONFLICT(session_id)
      DO UPDATE SET path=excluded.path,revision=excluded.revision,head=excluded.head`).run(id,snapshot.path,snapshot.revision,snapshot.head);
  });
  return true;
}
/* Shared index storage is owned by session-chunk-store. */
async function* sessionSnapshots(root, candidates, signal, onSkip, onRead) {
  for (const candidate of candidates) {
    signal.throwIfAborted();
    onRead?.(candidate);
    let diagnostic;
    const snapshot = await readSessionTranscript(root,candidate,signal, value => { diagnostic = value; }).catch(error => {
      signal.throwIfAborted();
      diagnostic = { sessionId: candidate.id, path: resolve(candidate.path), reason: "read_failed",
        ...(typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? { code: error.code } : {}) };
    });
    signal.throwIfAborted();
    if (diagnostic && onSkip) await onSkip(diagnostic);
    if (snapshot) yield snapshot;
    await yieldTask();
  }
}
/** Both hosts share the documents lease, content hashes and model namespace.
 * Stream one transcript at a time; recheck its file incarnation after HTTP. */
export async function indexSessionChunks(root, candidates, options) {
  const { signal, embedding } = options;
  const progress = sessionIndexProgress(root, candidates.length), counts = progress.state;
  let db, work, success = false, indexed = 0, total = 0, calls = 0, outcome = "failed", failure;
  const deadline = Date.now() + 40000;
  try {
    db = await storage(root,true);
    work = await claimWork(db,signal,{retry:options.retry === true});
    await writeTransaction(db,signal,() => { schema(db); work.assert(db); });
    const diagnostics = [];
    let deferred = 0;
    const admitted = [];
    for (const candidate of candidates) {
      if (!options.eligible || await options.eligible(candidate, signal)) admitted.push(candidate);
      else deferred++;
    }
    for await (const snapshot of sessionSnapshots(root,admitted,signal, async diagnostic => {
      counts.sessionsChecked++; counts.sessionsSkipped++;
      if (diagnostics.length < 100) diagnostics.push(diagnostic);
      await logSearchDiagnostic(root, { event: "session_transcript_skipped", ...diagnostic });
    }, candidate => { counts.phase = "reading"; counts.sessionId = candidate.id; })) {
      if (options.eligible && !await options.eligible(snapshot, signal)) { deferred++; continue; }
      total += snapshot.chunks.length;
      counts.sessionsChecked++; counts.chunksDiscovered = total; counts.phase = "saving";
      const published = await reconcile(db,snapshot,signal,work,async () => {
        if (!await transcriptUnchanged(snapshot,signal)) throw new Error("Session changed during indexing; refresh required");
        return !options.eligible || await options.eligible(snapshot, signal);
      });
      if (!published) { deferred++; continue; }
      if (!embedding) continue;
      counts.phase = "checking_cache";
      const identity = `session-chunks-v1:${embedding.identity}`;
      signal.throwIfAborted();
      if (!await embedding.authorized(signal)) throw new Error("Session embedding configuration changed");
      const saved = db.prepare(`SELECT vector FROM ${VECTORS} WHERE identity=? AND hash=?`);
      const missing = new Map();
      for (const c of snapshot.chunks) {
        if (!decode(saved.get(identity,c.hash)?.vector,embedding.dimension)) missing.set(c.hash,c.text);
        else counts.cachedChunks++;
      }
      for (;;) {
        signal.throwIfAborted();
        if (!missing.size || (!options.drain && (calls >= 16 || Date.now() >= deadline))) break;
        if (!await embedding.authorized(signal)) throw new Error("Session embedding configuration changed");
        if (options.eligible && !await options.eligible(snapshot, signal)) { deferred++; break; }
        const batch = [];
        for (const entry of missing) { batch.push(entry); if (batch.length === 16) break; }
        await writeTransaction(db,signal,() => work.network(db));
        counts.phase = "provider"; counts.requestsStarted++;
        let vectors;
        try {
          vectors = await work.run(() => embedding.embed(batch.map(([,text])=>text),signal,async () => {
            if (options.eligible && !await options.eligible(snapshot,signal)) throw new SessionIndexDeferred();
          }));
        } catch (error) {
          if (!(error instanceof SessionIndexDeferred)) throw error;
          deferred++; break;
        }
        counts.requestsCompleted++;
        if (vectors.length !== batch.length || !vectors.every(v=>valid(v,embedding.dimension))) throw new Error("Invalid session chunk vectors");
        if (!await embedding.authorized(signal)) throw new Error("Session embedding configuration changed");
        if (options.eligible && !await options.eligible(snapshot, signal)) { deferred++; break; }
        counts.phase = "saving";
        // Fences run just before the synchronous save, never while holding the write lock.
        if (!await transcriptUnchanged(snapshot,signal)) throw new Error("Session changed during indexing; refresh required");
        if (!await embedding.authorized(signal)) throw new Error("Session embedding configuration changed");
        if (options.eligible && !await options.eligible(snapshot, signal)) { deferred++; break; }
        await writeTransaction(db,signal,() => {
          work.assert(db);
          const insert = db.prepare(`INSERT OR REPLACE INTO ${VECTORS} VALUES(?,?,?)`);
          for (let i=0;i<batch.length;i++) {
            const bytes = Buffer.alloc(embedding.dimension*4);
            vectors[i].forEach((value,j)=>bytes.writeFloatLE(value,j*4));
            insert.run(identity,batch[i][0],bytes);
          }
        });
        counts.savedVectors += batch.length;
        for (const [hash] of batch) missing.delete(hash);
        calls++;
        await yieldTask();
      }
      indexed += snapshot.chunks.filter(chunk=>!missing.has(chunk.hash)).length;
    }
    success = true;
    const skipped = counts.sessionsSkipped;
    const complete = (!embedding || indexed===total) && skipped===0 && deferred===0;
    outcome = complete ? "completed" : "incomplete";
    return { indexed,total,complete,skipped,
      ...(deferred ? { deferred } : {}),
      ...(diagnostics.length ? { diagnostics } : {}) };
  } catch (error) { outcome = signal.aborted ? "cancelled" : "failed"; failure = error; throw error; }
  finally {
    try { try { if(work) await work.release(success); } finally { db?.close(); } }
    catch (error) { outcome = signal.aborted ? "cancelled" : "failed"; failure = error; throw error; }
    finally { await progress.finish(outcome,failure); }
  }
}
