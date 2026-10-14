import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { setImmediate as yieldTask } from "node:timers/promises";
import { storage, exists, valid, decode, INDEX_META, RANGES, SESSION_CHUNK_FORMAT } from "./session-chunk-store.js";
import { requireSourceEnabled } from "./source-policy.js";

const stamp = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
async function current(row, signal) {
  signal.throwIfAborted();
  const info = await lstat(row.path).catch(() => undefined);
  signal.throwIfAborted();
  return Boolean(info?.isFile() && !info.isSymbolicLink() && info.nlink === 1 && stamp(info) === row.file_stamp);
}
async function indexedFiles(db, root, candidates, signal) {
  if (!exists(db, INDEX_META) || !exists(db, RANGES)) return [];
  const allowed = candidates && new Map(candidates.map(c => [c.id, resolve(c.path)]));
  const rows = db.prepare(`SELECT * FROM ${INDEX_META} WHERE cwd=? AND format=? LIMIT 10001`).all(resolve(root), SESSION_CHUNK_FORMAT);
  if (rows.length > 10000) throw new Error("Session index candidate limit exceeded");
  const result = [];
  for (const row of rows) {
    if ((!allowed || allowed.get(row.session_id) === row.path) && await current(row,signal)) result.push(row);
  }
  return result;
}
/** Cold requests read SQLite + stat metadata only. Missing/stale entries are
 * omitted until the background indexer publishes a proven active branch. */
export async function listIndexedSessions(root, signal) {
  await requireSourceEnabled(root,"sessions",signal);
  const db = await storage(root,false);
  if (!db) return [];
  try {
    const rows = await indexedFiles(db,root,undefined,signal);
    await requireSourceEnabled(root,"sessions",signal);
    return rows.map(r => ({ id:r.session_id,path:r.path,cwd:r.cwd,name:r.name,
      title:r.title,firstMessage:r.first_message,revision:r.revision,fileStamp:r.file_stamp,head:r.head }));
  } finally { db.close(); }
}
const cosine = (a,b) => {
  let dot=0,aa=0,bb=0;
  for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}
  return Math.max(-1,Math.min(1,dot/(Math.sqrt(aa)*Math.sqrt(bb)||1)));
};
export async function searchSessionChunks(root,candidates,query,signal,embedding) {
  await requireSourceEnabled(root,"sessions",signal);
  const db = await storage(root,false);
  if (!db) return [];
  let transaction = false;
  try {
    db.exec("BEGIN");
    transaction = true;
    const files = await indexedFiles(db,root,candidates,signal), best = new Map();
    if (!files.length) return [];
    const terms = query.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu)?.slice(0,32) ?? [];
    if (!terms.length && !embedding) return [];
    const expression = terms.map(t => `"${t.replaceAll('"','""')}"*`).join(" AND ");
    const lexical = expression ? db.prepare(`SELECT c.*,r.*,1 AS lexical FROM pix_session_chunk_fts f
      JOIN pix_session_chunks c ON c.session_id=f.session_id AND c.message_id=f.message_id AND c.start=f.start
      JOIN ${RANGES} r ON r.session_id=c.session_id AND r.message_id=c.message_id AND r.start=c.start
      WHERE pix_session_chunk_fts MATCH ? AND c.session_id=? AND r.active=1`) : undefined;
    const semantic = embedding && valid(embedding.query,embedding.dimension) ? db.prepare(`SELECT c.*,r.*,v.vector FROM pix_session_chunks c
      JOIN ${RANGES} r ON r.session_id=c.session_id AND r.message_id=c.message_id AND r.start=c.start
      JOIN pix_session_chunk_vectors v ON v.hash=c.hash AND v.identity=? WHERE c.session_id=? AND r.active=1`) : undefined;
    let count=0;
    for(const file of files) {
      const consider = (row,score,isSemantic) => {
        if (!best.has(file.session_id) || best.get(file.session_id).score < score) best.set(file.session_id, {
          id:file.session_id,path:file.path,title:file.title,messageId:row.message_id,ordinal:row.ordinal,
          start:row.start,end:row.end,hash:row.hash,text:row.text,snippet:row.snippet,score,semantic:isSemantic,
          byteOffset:row.byte_offset,byteLength:row.byte_length,revision:file.revision,fileStamp:file.file_stamp,head:file.head,active:true });
      };
      for (const row of lexical?.all(expression,file.session_id) ?? []) {
        signal.throwIfAborted(); consider(row,1,false);
        if (++count % 128 === 0) await yieldTask();
      }
      for(const row of semantic?.all(`session-chunks-v1:${embedding.identity}`,file.session_id) ?? []) {
        signal.throwIfAborted();
        const vector=decode(row.vector,embedding.dimension), score=vector && cosine(vector,embedding.query);
        if (score !== undefined && score >= .25) consider(row,score,true);
        if (++count % 128 === 0) await yieldTask();
      }
    }
    // File or branch changes during a long vector scan cannot return stale rows.
    for(const file of files) if(best.has(file.session_id) && !await current(file,signal)) best.delete(file.session_id);
    await requireSourceEnabled(root,"sessions",signal);
    return [...best.values()].sort((a,b)=>b.score-a.score || a.id.localeCompare(b.id));
  } finally {
    try { if (transaction) db.exec("ROLLBACK"); } finally { db.close(); }
  }
}
export async function hasSessionChunkVectors(root,candidates,signal,embedding) {
  await requireSourceEnabled(root,"sessions",signal);
  const db=await storage(root,false);
  if(!db) return false;
  let transaction = false;
  try {
    db.exec("BEGIN");
    transaction = true;
    const files=await indexedFiles(db,root,candidates,signal);
    if(!exists(db,"pix_session_chunk_vectors")) return false;
    const lookup=db.prepare(`SELECT v.vector FROM pix_session_chunks c JOIN ${RANGES} r
      ON r.session_id=c.session_id AND r.message_id=c.message_id AND r.start=c.start
      JOIN pix_session_chunk_vectors v ON v.hash=c.hash AND v.identity=? WHERE c.session_id=? AND r.active=1`);
    for(const file of files) {
      signal.throwIfAborted();
      if(lookup.all(`session-chunks-v1:${embedding.identity}`,file.session_id).some(r=>decode(r.vector,embedding.dimension)) && await current(file,signal)) {
        await requireSourceEnabled(root,"sessions",signal); return true;
      }
      await yieldTask();
    }
    await requireSourceEnabled(root,"sessions",signal); return false;
  } finally {
    try { if (transaction) db.exec("ROLLBACK"); } finally { db.close(); }
  }
}
