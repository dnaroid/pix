import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { parse as parseJsonc } from "jsonc-parser";

export const digest = text => createHash("sha256").update(text).digest("hex");
export async function regularText(file, max = 65536) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > max) throw new Error("Unsafe configuration");
  const text = await readFile(file, "utf8");
  if (Buffer.byteLength(text) > max) throw new Error("Oversized configuration");
  return text;
}

export const semanticConfigurationPath = () => join(process.env.HOME?.trim() || homedir(), ".config/pi/pi-tools-suite.jsonc");

export async function semanticConfigurationText(file = semanticConfigurationPath()) {
  // Reject redirected configuration ancestors, not just a linked final file.
  for (const directory of [join(file, "../.."), join(file, "..")]) {
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe configuration directory");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  try { return await regularText(file, 1024 * 1024); }
  catch (error) { if (error.code === "ENOENT") return "{}"; throw error; }
}

export function parseSemanticConfiguration(text) {
  const errors = [];
  const settings = parseJsonc(text, errors, { allowTrailingComma: true });
  if (Buffer.byteLength(text) > 1024 * 1024 || errors.length || !settings || typeof settings !== "object" || Array.isArray(settings)
    || (settings.search !== undefined && (!settings.search || typeof settings.search !== "object" || Array.isArray(settings.search)))) {
    throw new Error("Invalid suite settings");
  }
  return settings;
}

/** Only the canonical global suite's explicit search.embedding authorizes uploads. */
export function parseEmbeddingSettings(text) {
  try {
    const settings = parseSemanticConfiguration(text);
    if (!settings.search || !Object.hasOwn(settings.search, "embedding")) return;
    const source = JSON.stringify(settings.search.embedding);
    if (Buffer.byteLength(source) > 8192) return;
    const input = JSON.parse(source);
    for (const field of ["knowledgeEmbeddingModel", "knowledgeEmbeddingQueryPrefix", "knowledgeEmbeddingDocumentPrefix", "ollamaBaseUrl"]) {
      if (input[field] !== undefined && typeof input[field] !== "string") return;
    }
    const provider = input.embeddingProvider, dimension = input.vectorSize;
    if (!["openrouter", "ollama"].includes(provider) || !Number.isInteger(dimension) || dimension < 1 || dimension > 8192) return;
    const baseUrl = provider === "openrouter" ? "https://openrouter.ai/api/v1" : input.ollamaBaseUrl ?? "http://127.0.0.1:11434";
    if (baseUrl.length > 2048) return;
    const url = new URL(baseUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return;
    const configs = {};
    for (const kind of ["code", "knowledge"]) {
      const knowledge = kind === "knowledge";
      const model = knowledge ? input.knowledgeEmbeddingModel ?? input.embeddingModel : input.embeddingModel;
      const queryPrefix = knowledge ? input.knowledgeEmbeddingQueryPrefix ?? (provider === "ollama" ? "search_query: " : "") : "";
      const documentPrefix = knowledge ? input.knowledgeEmbeddingDocumentPrefix ?? (provider === "ollama" ? "search_document: " : "") : "";
      if (typeof model !== "string" || !model.trim() || model.length > 256 || model.includes("\0")
        || [queryPrefix, documentPrefix].some(value => typeof value !== "string" || value.length > 512 || value.includes("\0"))) return;
      const config = { provider, model, dimension, queryPrefix, documentPrefix, baseUrl: url.toString().replace(/\/$/, "") };
      configs[kind] = { ...config, identity: digest(JSON.stringify([1, config])) };
    }
    return { signature: digest(source), enabled: true, configs };
  } catch { return; }
}

// Keep the repository-call signature; the workspace never selects authorization.
export async function repositoryEmbeddingSettings(_root = "", _requireConsent = true, file = semanticConfigurationPath()) {
  try { return parseEmbeddingSettings(await semanticConfigurationText(file)); }
  catch { return; }
}

/** Shared credentials, never a project file or a legacy provider configuration. */
export async function repositoryEmbeddingKey() {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (key) return key;
  const home = process.env.HOME?.trim() || homedir();
  const directory = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/|$)/, home) || join(home, ".pi/agent");
  try {
    const entry = JSON.parse(await regularText(join(directory, "auth.json"), 512 * 1024))?.openrouter;
    if (entry?.type === "api_key" && typeof entry.key === "string" && entry.key.trim() && entry.key.length <= 10000) return entry.key;
  } catch { /* Missing or unsafe credentials leave lexical search available. */ }
}

export function validVector(vector, dimension) {
  return Array.isArray(vector) && vector.length === dimension
    && vector.every(value => typeof value === "number" && Number.isFinite(value) && Number.isFinite(Math.fround(value)))
    && vector.some(value => Math.fround(value) !== 0);
}
function decode(vector, dimension) {
  if (typeof vector === "string") {
    const bytes = Buffer.from(vector, "base64");
    if (bytes.length !== dimension * 4 || bytes.toString("base64") !== vector) throw new Error("Invalid vector");
    vector = Array.from({ length: dimension }, (_, i) => bytes.readFloatLE(i * 4));
  }
  if (!validVector(vector, dimension)) throw new Error("Invalid vector");
  return vector;
}
export async function embedRepository(inputs, config, key, signal) {
  if (!inputs.length || inputs.length > 16 || inputs.some(text => typeof text !== "string" || !text || text.length > 8704)
    || (config.provider === "openrouter" && !key)) throw new Error("Embedding prerequisites unavailable");
  const owned = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  // Errors/bodies/credentials never cross the public search response boundary.
  const response = await fetch(`${config.baseUrl}/${config.provider === "openrouter" ? "embeddings" : "api/embed"}`, {
    method: "POST", signal: owned,
    headers: { "Content-Type": "application/json", ...(config.provider === "openrouter" ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: config.model, input: inputs,
      ...(config.provider === "openrouter" ? { encoding_format: "float" } : { truncate: true }) }),
  });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Embedding unavailable"); }
  const reader = response.body.getReader(), parts = [];
  let bytes = 0;
  try {
    while (true) {
      owned.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 4000000) throw new Error("Embedding response too large");
      parts.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const data = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (data.model !== config.model && !(config.provider === "openrouter" && config.model.includes("/")
    && data.model === config.model.slice(config.model.indexOf("/") + 1))) throw new Error("Embedding model mismatch");
  if (config.provider === "ollama") {
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== inputs.length) throw new Error("Embedding count mismatch");
    return data.embeddings.map(value => decode(value, config.dimension));
  }
  if (data.object !== "list" || !Array.isArray(data.data) || data.data.length !== inputs.length) throw new Error("Invalid embeddings");
  const vectors = new Array(inputs.length);
  for (const item of data.data) {
    if (item?.object !== "embedding" || !Number.isInteger(item.index) || item.index < 0 || item.index >= inputs.length || vectors[item.index]) throw new Error("Invalid embedding index");
    vectors[item.index] = decode(item.embedding, config.dimension);
  }
  return vectors;
}
