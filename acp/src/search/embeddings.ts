import { SEARCH_EMBEDDING_MODEL } from "./contract.js";

export const EMBEDDING_DIMENSIONS = 1024;
export const EMBEDDING_ENDPOINT = "https://openrouter.ai/api/v1/embeddings";
export type Embedder = (input: readonly string[], key: string, signal: AbortSignal) => Promise<number[][]>;
export function validVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === EMBEDDING_DIMENSIONS && value.every(v => typeof v === "number" && Number.isFinite(v) && Number.isFinite(Math.fround(v)))
    && value.some(v => Math.fround(v) !== 0);
}
/** Only canonical standard base64 of exactly 1024 float32 little-endian values. */
function decodeVector(value: unknown): number[] {
  if (typeof value === "string") {
    if (value.length !== Math.ceil(EMBEDDING_DIMENSIONS * 4 / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Invalid embedding response");
    const buffer = Buffer.from(value, "base64");
    if (buffer.length !== EMBEDDING_DIMENSIONS * 4 || buffer.toString("base64") !== value) throw new Error("Invalid embedding response");
    value = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => buffer.readFloatLE(i * 4));
  }
  if (!validVector(value)) throw new Error("Invalid embedding response");
  return value;
}
/** Request float explicitly; reject quantized, binary, malformed and nonfinite representations. */
export function decodeEmbeddings(value: unknown, count: number): number[][] {
  if (!value || typeof value !== "object") throw new Error("Invalid embedding response");
  const response = value as Record<string, unknown>;
  // OpenRouter routes by the qualified ID; Perplexity returns the same model without its provider prefix.
  const expectedModel = response.model === SEARCH_EMBEDDING_MODEL || response.model === "pplx-embed-v1-0.6b";
  if (response.object !== "list" || !expectedModel || !Array.isArray(response.data) || response.data.length !== count) throw new Error("Invalid embedding response");
  const vectors: number[][] = new Array(count);
  for (const item of response.data) {
    if (!item || typeof item !== "object" || item.object !== "embedding" || !Number.isInteger(item.index)
      || item.index < 0 || item.index >= count || vectors[item.index]) throw new Error("Invalid embedding response");
    vectors[item.index] = decodeVector(item.embedding);
  }
  if (vectors.filter(Boolean).length !== count) throw new Error("Invalid embedding response");
  return vectors;
}
export const embedOpenRouter: Embedder = async (input, key, signal) => {
  if (input.length < 1 || input.length > 16 || input.some(text => text.length > 2000)) throw new Error("Invalid embedding batch");
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  // Transport exceptions and provider bodies are deliberately not propagated or logged.
  try {
    const response = await fetch(EMBEDDING_ENDPOINT, { method: "POST", signal: bounded,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: SEARCH_EMBEDDING_MODEL, input, encoding_format: "float" }),
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Search provider unavailable"); }
    const reader = response.body.getReader();
    const buffers: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        bounded.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 2_000_000) throw new Error("Invalid embedding response");
        buffers.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return decodeEmbeddings(JSON.parse(Buffer.concat(buffers).toString("utf8")), input.length);
  } catch { throw new Error("Semantic search unavailable; local search remains available"); }
};
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i]!, y = b[i]!; dot += x * y; aa += x * x; bb += y * y; }
  const value = dot / Math.sqrt(aa * bb);
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}
