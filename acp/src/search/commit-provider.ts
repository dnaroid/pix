import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseEnv } from "node:util";

export interface CommitEmbeddingConfig {
  readonly provider: "openrouter" | "ollama"; readonly model: string; readonly dimension: number;
  readonly queryPrefix: string; readonly documentPrefix: string; readonly baseUrl: string;
}
export type CommitEmbedder = (input: readonly string[], config: CommitEmbeddingConfig, key: string | undefined, signal: AbortSignal) => Promise<number[][]>;
export const SEMANTIC_NOTICE = "Commit semantic search unavailable; local BM25 results remain available.";
export function embeddingIdentity(c: CommitEmbeddingConfig): string {
  return JSON.stringify([1, c.provider, c.model, c.dimension, c.queryPrefix, c.documentPrefix, c.baseUrl]);
}
async function boundedFile(path: string, max: number): Promise<string> {
  const s = await stat(path);
  if (!s.isFile() || s.size > max) throw new Error("Invalid configuration");
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > max) throw new Error("Invalid configuration");
  return text;
}
export async function loadCommitEmbeddingConfig(cwd: string): Promise<CommitEmbeddingConfig | undefined> {
  try {
    const p = JSON.parse(await boundedFile(join(cwd, ".indexer-cli", "config.json"), 65536));
    const provider = p.embeddingProvider;
    const model = p.knowledgeEmbeddingModel ?? p.embeddingModel;
    const dimension = p.vectorSize;
    if ((provider !== "openrouter" && provider !== "ollama") || typeof model !== "string" || !model.trim() || model.length > 256
      || !Number.isInteger(dimension) || dimension < 1 || dimension > 8192) return undefined;
    const queryPrefix = p.knowledgeEmbeddingQueryPrefix ?? (provider === "ollama" ? "search_query: " : "");
    const documentPrefix = p.knowledgeEmbeddingDocumentPrefix ?? (provider === "ollama" ? "search_document: " : "");
    if (typeof queryPrefix !== "string" || typeof documentPrefix !== "string" || queryPrefix.length > 512 || documentPrefix.length > 512) return undefined;
    const baseUrl = provider === "openrouter" ? "https://openrouter.ai/api/v1" : (p.ollamaBaseUrl ?? "http://127.0.0.1:11434");
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return { provider, model, dimension, queryPrefix, documentPrefix, baseUrl: url.toString().replace(/\/$/, "") };
  } catch { return undefined; }
}
/** IDX's credential precedence, without loading or mutating its singleton. */
export async function loadCommitEmbeddingKey(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<string | undefined> {
  const direct = env.OPENROUTER_API_KEY?.trim();
  if (direct) return direct;
  const root = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
  try { return parseEnv(await boundedFile(join(root, "idx", ".env"), 65536)).OPENROUTER_API_KEY?.trim() || undefined; }
  catch { return undefined; }
}
export function validCommitVector(v: unknown, dimension: number): v is number[] {
  return Array.isArray(v) && v.length === dimension && v.every(n => typeof n === "number" && Number.isFinite(n) && Number.isFinite(Math.fround(n)))
    && v.some(n => Math.fround(n) !== 0);
}
function decodeVector(v: unknown, dimension: number): number[] {
  if (typeof v === "string") {
    const b = Buffer.from(v, "base64");
    if (b.length !== dimension * 4 || b.toString("base64") !== v) throw new Error(SEMANTIC_NOTICE);
    v = Array.from({ length: dimension }, (_, i) => b.readFloatLE(i * 4));
  }
  if (!validCommitVector(v, dimension)) throw new Error(SEMANTIC_NOTICE);
  return v;
}
export const embedCommitHTTP: CommitEmbedder = async (input, c, key, signal) => {
  try {
    if (!input.length || input.length > 16 || input.some(t => t.length > 8192) || (c.provider === "openrouter" && !key)) throw new Error();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const response = await fetch(`${c.baseUrl}/${c.provider === "openrouter" ? "embeddings" : "api/embed"}`, {
      method: "POST", signal: bounded, headers: { "Content-Type": "application/json", ...(key && c.provider === "openrouter" ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: c.model, input, ...(c.provider === "openrouter" ? { encoding_format: "float" } : { truncate: true }) }),
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(); }
    const reader = response.body.getReader();
    const parts: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        bounded.throwIfAborted(); const part = await reader.read(); if (part.done) break;
        bytes += part.value.length; if (bytes > 4_000_000) throw new Error(); parts.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const p = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (p.model !== c.model && !(c.provider === "openrouter" && c.model.includes("/") && p.model === c.model.slice(c.model.indexOf("/") + 1))) throw new Error();
    if (c.provider === "ollama") {
      if (!Array.isArray(p.embeddings) || p.embeddings.length !== input.length) throw new Error();
      return p.embeddings.map((v: unknown) => decodeVector(v, c.dimension));
    }
    if (p.object !== "list" || !Array.isArray(p.data) || p.data.length !== input.length) throw new Error();
    const vectors: number[][] = new Array(input.length);
    for (const item of p.data) {
      if (item.object !== "embedding" || !Number.isInteger(item.index) || item.index < 0 || item.index >= input.length || vectors[item.index]) throw new Error();
      vectors[item.index] = decodeVector(item.embedding, c.dimension);
    }
    if (vectors.filter(Boolean).length !== input.length) throw new Error();
    return vectors;
  } catch { if (signal.aborted) signal.throwIfAborted(); throw new Error(SEMANTIC_NOTICE); }
};
