import { join, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import { setImmediate as yieldTask } from "node:timers/promises";
import { beginWrite, claimWork, openDatabase, safeDirectory, safeFile, sourcePath } from "./source-work.js";
import { readSessionTranscript, transcriptUnchanged } from "./session-transcript.js";
import { logSearchDiagnostic } from "./search-diagnostics.js";
import { sessionIndexProgress } from "./session-index-progress.js";

const DOCUMENTS = "pix_session_chunks";
const VECTORS = "pix_session_chunk_vectors";
const META = "pix_session_chunk_meta";
const FTS = "pix_session_chunk_fts";
const exists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name));
function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${META}(session_id TEXT PRIMARY KEY,path TEXT NOT NULL,revision TEXT NOT NULL,head TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ${DOCUMENTS}(session_id TEXT NOT NULL,message_id TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL,text TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(session_id,message_id,start));
    CREATE INDEX IF NOT EXISTS pix_session_chunk_hash ON ${DOCUMENTS}(hash);
    CREATE TABLE IF NOT EXISTS ${VECTORS}(identity TEXT NOT NULL,hash TEXT NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(identity,hash));
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS} USING fts5(session_id UNINDEXED,message_id UNINDEXED,start UNINDEXED,text,tokenize='unicode61');`);
}
async function reconcile(db, snapshot, signal) {
  const saved = db.prepare(`SELECT revision FROM ${META} WHERE session_id=?`).get(snapshot.id);
  if (saved?.revision === snapshot.revision) return;
  db.prepare(`DELETE FROM ${DOCUMENTS} WHERE session_id=?`).run(snapshot.id);
  db.prepare(`DELETE FROM ${FTS} WHERE session_id=?`).run(snapshot.id);
  db.prepare(`INSERT INTO ${META} VALUES(?,?,?,?) ON CONFLICT(session_id)
    DO UPDATE SET path=excluded.path,revision=excluded.revision,head=excluded.head`).run(snapshot.id,snapshot.path,snapshot.revision,snapshot.head);
  const insert = db.prepare(`INSERT INTO ${DOCUMENTS} VALUES(?,?,?,?,?,?,?,?,?)`);
  const fts = db.prepare(`INSERT INTO ${FTS} VALUES(?,?,?,?)`);
  let count = 0;
  for (const c of snapshot.chunks) {
    signal.throwIfAborted();
    insert.run(snapshot.id,c.messageId,c.start,c.end,c.ordinal,c.role,c.status,c.text,c.hash);
    fts.run(snapshot.id,c.messageId,c.start,c.text);
    if (++count % 128 === 0) await yieldTask();
  }
}
async function storage(root, create) {
  root = resolve(root);
  for (const path of [join(root,".pi"),join(root,".pi/search")]) {
    if (create) await safeDirectory(path);
    else {
      const s = await lstat(path).catch(() => undefined);
      if (!s) return;
      if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Unsafe session index directory");
    }
  }
  const file = sourcePath(root,"sessions");
  await safeFile(file);
  if (create) return openDatabase(file);
  if (!await lstat(file).catch(() => undefined)) return;
  if ("Bun" in globalThis) { const { Database } = await import("bun:sqlite"); return new Database(file,{readonly:true}); }
  const { DatabaseSync } = await import("node:sqlite"); return new DatabaseSync(file,{readOnly:true});
}
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
const valid = (vector, dimension) => Array.isArray(vector) && vector.length === dimension
  && vector.every(value=>Number.isFinite(value) && Number.isFinite(Math.fround(value)))
  && vector.some(value => Math.fround(value) !== 0);
function decode(bytes, dimension) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== dimension * 4) return;
  const b = Buffer.from(bytes), v = Array.from({length:dimension},(_,i)=>b.readFloatLE(i*4));
  return valid(v,dimension) ? v : undefined;
}
/** Both hosts share the documents lease, content hashes and model namespace.
 * Stream one transcript at a time; recheck its file incarnation after HTTP. */
export async function indexSessionChunks(root, candidates, options) {
  const { signal, embedding } = options;
  const progress = sessionIndexProgress(root, candidates.length), counts = progress.state;
  let db, work, success = false, indexed = 0, total = 0, inspected = 0, calls = 0, outcome = "failed";
  const deadline = Date.now() + 40000;
  try {
    db = await storage(root,true);
    work = await claimWork(db,signal,{retry:options.retry === true});
    await beginWrite(db,signal);
    try { schema(db); work.assert(db); db.exec("COMMIT"); }
    catch (e) { db.exec("ROLLBACK"); throw e; }
    const diagnostics = [];
    for await (const snapshot of sessionSnapshots(root,candidates,signal, async diagnostic => {
      counts.sessionsChecked++; counts.sessionsSkipped++;
      if (diagnostics.length < 100) diagnostics.push(diagnostic);
      await logSearchDiagnostic(root, { event: "session_transcript_skipped", ...diagnostic });
    }, candidate => { counts.phase = "reading"; counts.sessionId = candidate.id; })) {
      inspected++; total += snapshot.chunks.length;
      counts.sessionsChecked++; counts.chunksDiscovered = total; counts.phase = "saving";
      await beginWrite(db,signal);
      try {
        await reconcile(db,snapshot,signal);
        work.assert(db); db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
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
        const batch = [];
        for (const entry of missing) { batch.push(entry); if (batch.length === 16) break; }
        await beginWrite(db,signal);
        try { work.network(db); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
        counts.phase = "provider"; counts.requestsStarted++;
        const vectors = await work.run(() => embedding.embed(batch.map(([,text])=>text),signal));
        counts.requestsCompleted++;
        if (vectors.length !== batch.length || !vectors.every(v=>valid(v,embedding.dimension))) throw new Error("Invalid session chunk vectors");
        if (!await embedding.authorized(signal)) throw new Error("Session embedding configuration changed");
        counts.phase = "saving";
        await beginWrite(db,signal);
        try {
          if (!await transcriptUnchanged(snapshot,signal)) throw new Error("Session changed during indexing; refresh required");
          if (!await embedding.authorized(signal)) throw new Error("Session embedding configuration changed");
          work.assert(db);
          const insert = db.prepare(`INSERT OR REPLACE INTO ${VECTORS} VALUES(?,?,?)`);
          for (let i=0;i<batch.length;i++) {
            const bytes = Buffer.alloc(embedding.dimension*4);
            vectors[i].forEach((value,j)=>bytes.writeFloatLE(value,j*4));
            insert.run(identity,batch[i][0],bytes);
          }
          db.exec("COMMIT");
          counts.savedVectors += batch.length;
        } catch(e) { db.exec("ROLLBACK"); throw e; }
        for (const [hash] of batch) missing.delete(hash);
        calls++;
        await yieldTask();
      }
      indexed += snapshot.chunks.filter(chunk=>!missing.has(chunk.hash)).length;
    }
    success = true;
    const complete = (!embedding || indexed===total) && inspected===candidates.length;
    outcome = complete ? "completed" : "incomplete";
    return { indexed,total,complete,skipped:candidates.length-inspected,
      ...(diagnostics.length ? { diagnostics } : {}) };
  } catch (error) { outcome = signal.aborted ? "cancelled" : "failed"; throw error; }
  finally {
    try { try { if(work) await work.release(success); } finally { db?.close(); } }
    catch (error) { outcome = signal.aborted ? "cancelled" : "failed"; throw error; }
    finally { await progress.finish(outcome); }
  }
}
function cosine(a,b) { let dot=0,aa=0,bb=0; for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]**2;bb+=b[i]**2;} return dot/Math.sqrt(aa*bb); }
/** Avoid paying for a query when no fresh compatible message vector exists. */
export async function hasSessionChunkVectors(root,candidates,signal,embedding) {
  const db = await storage(root,false);
  try {
    if (!db || !exists(db,VECTORS)) return false;
    const saved = db.prepare(`SELECT vector FROM ${VECTORS} WHERE identity=? AND hash=?`);
    for await (const s of sessionSnapshots(root,candidates,signal)) for (const c of s.chunks) {
      if (decode(saved.get(`session-chunks-v1:${embedding.identity}`,c.hash)?.vector,embedding.dimension)) return true;
    }
    return false;
  } finally { db?.close(); }
}
/** Rank only fresh live-branch chunks. Cache-only vectors; lexical makes no provider call. */
export async function searchSessionChunks(root,candidates,query,signal,embedding) {
  const db = embedding ? await storage(root,false) : undefined;
  try {
    const vectors = db && exists(db,VECTORS) ? db.prepare(`SELECT vector FROM ${VECTORS} WHERE identity=? AND hash=?`) : undefined;
    const terms = [...new Set(query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
    const hits = [];
    for await (const s of sessionSnapshots(root,candidates,signal)) {
      let best;
      for(const c of s.chunks) {
        signal.throwIfAborted();
        const text = c.text.normalize("NFKC").toLowerCase();
        const lexical = terms.length && terms.every(term=>text.includes(term)) ? 1 : 0;
        const vector = embedding && vectors ? decode(vectors.get(`session-chunks-v1:${embedding.identity}`,c.hash)?.vector,embedding.dimension) : undefined;
        const similarity = vector ? cosine(embedding.query,vector) : 0;
        const score = Math.max(lexical,similarity >= .25 ? similarity : 0);
        if(score > 0 && (!best || score > best.score)) best = {id:s.id,messageId:c.messageId,start:c.start,end:c.end,
          snippet:`[${c.role} ${c.messageId}:${c.start}-${c.end}] ${c.text.slice(0,1800)}`,score,semantic:similarity >= .25};
      }
      if(best) hits.push(best);
      await yieldTask();
    }
    return hits.sort((a,b)=>b.score-a.score || a.id.localeCompare(b.id));
  } finally { db?.close(); }
}
