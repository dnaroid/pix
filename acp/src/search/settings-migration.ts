import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldTask } from "node:timers/promises";
import { chunkText, hashText } from "./documents.js";
import { compatibleEmbeddingMetadata } from "./embedding-cache.js";
import type { SemanticEmbeddingConfig } from "./config.js";
import { EMBEDDING_DIMENSIONS, validVector } from "./embeddings.js";
import { safeFile } from "./source-work.js";

/** Import only validated, compatible metadata/vectors, never leases or receipts.
 * The destination's owned transaction makes partial import and competing windows atomic. */
export async function importLegacySettings(destination: DatabaseSync, cwd: string, signal: AbortSignal,
  config?: SemanticEmbeddingConfig): Promise<void> {
  const directory = join(resolve(cwd), ".pi/search");
  for (const path of [join(resolve(cwd), ".pi"), directory]) {
    const info = await lstat(path).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe legacy settings directory");
  }
  const filename = join(directory, "settings.sqlite");
  if (!await lstat(filename).catch(error => { if (error.code !== "ENOENT") throw error; })) return;
  await safeFile(filename);
  const legacy = new DatabaseSync(filename, { readOnly: true });
  try {
    legacy.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5; BEGIN");
    const tables = new Set(legacy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!["metadata", "documents", "vectors"].every(table => tables.has(table))) throw new Error("Invalid legacy settings schema");
    if (legacy.prepare("SELECT value FROM metadata WHERE key='schema'").get()?.value !== "2"
      || !compatibleEmbeddingMetadata(legacy, "metadata", config)) return;
    const putDocument = destination.prepare("INSERT INTO documents(id,text,hit,hashes) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING");
    const putVector = destination.prepare("INSERT INTO vectors(hash,vector) VALUES(?,?) ON CONFLICT(hash) DO NOTHING");
    const findVector = legacy.prepare("SELECT vector FROM vectors WHERE hash=?");
    let rows = 0, bytes = 0;
    for (const row of legacy.prepare("SELECT id,text,hit,hashes FROM documents LIMIT 10001").iterate()) {
      signal.throwIfAborted();
      if (++rows > 10000 || typeof row.id !== "string" || typeof row.text !== "string" || typeof row.hit !== "string"
        || typeof row.hashes !== "string") throw new Error("Invalid legacy settings document");
      bytes += Buffer.byteLength(row.text) + Buffer.byteLength(row.hit) + Buffer.byteLength(row.hashes);
      if (bytes > 64 * 1024 * 1024 || row.text.length > 1024 * 1024) throw new Error("Legacy settings import exceeds limit");
      const hit = JSON.parse(row.hit);
      const hashes = chunkText(row.text).map(hashText);
      if (hit?.kind !== "settings" || hit.id !== row.id || !row.id.startsWith("settings:")
        || JSON.stringify(hashes) !== row.hashes
        || ![hit.fieldId, hit.section, hit.title, hit.snippet].every(value => typeof value === "string")) throw new Error("Invalid legacy settings metadata");
      const cleanHit = { kind: "settings", id: hit.id, fieldId: hit.fieldId, section: hit.section, title: hit.title, snippet: hit.snippet, score: 0 };
      putDocument.run(row.id, row.text, JSON.stringify(cleanHit), row.hashes);
      for (const hash of hashes) {
        const value = findVector.get(hash)?.vector;
        if (value === undefined) continue;
        const dimension = config?.dimension ?? EMBEDDING_DIMENSIONS;
        if (!(value instanceof Uint8Array) || value.byteLength !== dimension * 4) throw new Error("Invalid legacy settings vector");
        const buffer = Buffer.from(value);
        if (!validVector(Array.from({ length: dimension }, (_, i) => buffer.readFloatLE(i * 4)), dimension)) throw new Error("Invalid legacy settings vector");
        bytes += buffer.length;
        if (bytes > 64 * 1024 * 1024) throw new Error("Legacy settings import exceeds limit");
        putVector.run(hash, buffer);
      }
      if (rows % 32 === 0) await yieldTask();
    }
  } finally { try { legacy.exec("ROLLBACK"); } finally { legacy.close(); } }
}
