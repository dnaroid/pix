import type { DatabaseSync } from "node:sqlite";
import { SEARCH_CACHE_REBUILD_REQUIRED, SEARCH_EMBEDDING_MODEL } from "./contract.js";
import { semanticEmbeddingIdentity, type SemanticEmbeddingConfig } from "./config.js";
import { EMBEDDING_DIMENSIONS } from "./embeddings.js";

export class SearchCacheCompatibilityError extends Error {
  constructor() { super(SEARCH_CACHE_REBUILD_REQUIRED); }
}

export function embeddingMetadata(config?: SemanticEmbeddingConfig): Record<string, string> {
  return { model: config?.model ?? SEARCH_EMBEDDING_MODEL, dimensions: String(config?.dimension ?? EMBEDDING_DIMENSIONS), encoding: "float32le",
    ...(config ? { identity: semanticEmbeddingIdentity(config) } : {}) };
}
export function compatibleEmbeddingMetadata(db: DatabaseSync, table: string, config?: SemanticEmbeddingConfig): boolean {
  const get = db.prepare(`SELECT value FROM ${table} WHERE key=?`);
  return Object.entries(embeddingMetadata(config)).every(([key, value]) => get.get(key)?.value === value)
    && (config !== undefined || get.get("identity") === undefined);
}
/** An explicit configuration cannot silently reinterpret an old model-only identity. */
export function initializeEmbeddingMetadata(db: DatabaseSync, table: string, config?: SemanticEmbeddingConfig): void {
  if (Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count) > 0) {
    if (!compatibleEmbeddingMetadata(db, table, config)) throw new SearchCacheCompatibilityError();
    return;
  }
  const put = db.prepare(`INSERT INTO ${table}(key,value) VALUES (?,?)`);
  for (const [key, value] of Object.entries(embeddingMetadata(config))) put.run(key, value);
}
