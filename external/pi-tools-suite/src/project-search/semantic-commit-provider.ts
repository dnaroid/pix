import { repositoryEmbeddingSettings, repositoryEmbeddingKey } from "./native-embedding-provider.mjs";

/** History sources share the centrally configured Knowledge identity. */
export interface CommitEmbeddingConfig {
  provider: "openrouter" | "ollama";
  model: string;
  dimension: number;
  queryPrefix: string;
  documentPrefix: string;
  baseUrl: string;
}

export function commitIdentity(config: CommitEmbeddingConfig): string {
  return JSON.stringify([1, config.provider, config.model, config.dimension,
    config.queryPrefix, config.documentPrefix, config.baseUrl]);
}

export async function loadCommitConfig(root: string): Promise<CommitEmbeddingConfig | undefined> {
  try {
    return (await repositoryEmbeddingSettings(root))?.configs.knowledge;
  } catch { return; }
}

/** Environment, then bounded shared SDK credential storage; never config secrets. */
export async function loadCommitKey(): Promise<string | undefined> {
  return repositoryEmbeddingKey();
}

export function validCommitVector(value: unknown, dimension: number): value is number[] {
  return Array.isArray(value) && value.length === dimension
    && value.every(n => typeof n === "number" && Number.isFinite(n) && Number.isFinite(Math.fround(n)))
    && value.some(n => Math.fround(n) !== 0);
}

function decode(input: unknown, dimension: number): number[] {
  let values = input;
  if (typeof values === "string") {
    const bytes = Buffer.from(values, "base64");
    if (bytes.length !== dimension * 4 || bytes.toString("base64") !== values) throw new Error("Invalid commit vector");
    values = Array.from({ length: dimension }, (_, index) => bytes.readFloatLE(index * 4));
  }
  if (!validCommitVector(values, dimension)) throw new Error("Invalid commit vector");
  return values;
}

/** The same shape as Desktop's commit embedder, but request timeout cannot
 * consume the entire 60-second project_search deadline. */
export async function embedCommits(inputs: readonly string[], config: CommitEmbeddingConfig,
  key: string | undefined, signal: AbortSignal): Promise<number[][]> {
  if (!inputs.length || inputs.length > 16 || inputs.some(input => !input || input.length > 8192)
    || (config.provider === "openrouter" && !key)) throw new Error("Invalid commit embedding batch");
  const owned = AbortSignal.any([signal, AbortSignal.timeout(9_000)]);
  const response = await fetch(`${config.baseUrl}/${config.provider === "openrouter" ? "embeddings" : "api/embed"}`, {
    method: "POST", signal: owned,
    headers: { "Content-Type": "application/json",
      ...(key && config.provider === "openrouter" ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: config.model, input: inputs,
      ...(config.provider === "openrouter" ? { encoding_format: "float" } : { truncate: true }) }),
  });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Commit embedding unavailable"); }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      owned.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 4_000_000) throw new Error("Commit embedding response too large");
      parts.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const data: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid commit embedding response");
  const result = data as Record<string, unknown>;
  if (result.model !== config.model && !(config.provider === "openrouter" && config.model.includes("/")
    && result.model === config.model.slice(config.model.indexOf("/") + 1))) {
    throw new Error("Incompatible commit embedding model");
  }
  if (config.provider === "ollama") {
    if (!Array.isArray(result.embeddings) || result.embeddings.length !== inputs.length) throw new Error("Invalid commit embedding response");
    return result.embeddings.map(v => decode(v, config.dimension));
  }
  if (result.object !== "list" || !Array.isArray(result.data) || result.data.length !== inputs.length) throw new Error("Invalid commit embedding response");
  const vectors: number[][] = new Array(inputs.length);
  for (const entry of result.data) {
    if (!entry || typeof entry !== "object" || entry.object !== "embedding" || !Number.isInteger(entry.index)
      || entry.index < 0 || entry.index >= inputs.length || vectors[entry.index]) throw new Error("Invalid commit embedding response");
    vectors[entry.index] = decode(entry.embedding, config.dimension);
  }
  if (vectors.filter(Boolean).length !== inputs.length) throw new Error("Invalid commit embedding response");
  return vectors;
}
