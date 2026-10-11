import { lstat, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";

export const semanticSearchConfigPath = () => join(process.env.HOME?.trim() || homedir(), ".config", "pi", "pi-tools-suite.jsonc");
export interface SemanticEmbeddingConfig {
  readonly provider: "openrouter" | "ollama"; readonly model: string; readonly dimension: number;
  readonly queryPrefix: string; readonly documentPrefix: string; readonly baseUrl: string;
}
export function semanticEmbeddingIdentity(c: SemanticEmbeddingConfig): string {
  return JSON.stringify([1, c.provider, c.model, c.dimension, c.queryPrefix, c.documentPrefix, c.baseUrl]);
}
/** Global suite JSONC only; never merge project configuration or repair storage. */
export async function loadSemanticEmbeddingConfig(path = semanticSearchConfigPath()): Promise<SemanticEmbeddingConfig | undefined> {
  try {
    for (const directory of [dirname(dirname(path)), dirname(path)]) {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    }
    const stat = await lstat(path);
    const maxBytes = 1024 * 1024;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) return undefined;
    const handle = await open(path, "r");
    let text: string;
    try {
      const actual = await handle.stat();
      if (actual.dev !== stat.dev || actual.ino !== stat.ino || !actual.isFile() || actual.nlink !== 1 || actual.size > maxBytes) return undefined;
      const bytes = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > maxBytes) return undefined;
      text = bytes.subarray(0, bytesRead).toString("utf8");
    } finally { await handle.close(); }
    const errors: ParseError[] = [];
    const value = parseJsonc(text, errors, { allowTrailingComma: true });
    const search = value?.search, p = search?.embedding;
    if (errors.length || !value || typeof value !== "object" || Array.isArray(value)
      || !search || typeof search !== "object" || Array.isArray(search)
      || !p || typeof p !== "object" || Array.isArray(p) || Buffer.byteLength(JSON.stringify(p)) > 8192) return undefined;
    for (const field of ["knowledgeEmbeddingModel", "knowledgeEmbeddingQueryPrefix", "knowledgeEmbeddingDocumentPrefix", "ollamaBaseUrl"]) {
      if (p[field] !== undefined && typeof p[field] !== "string") return undefined;
    }
    const provider = p.embeddingProvider;
    if ((provider !== "openrouter" && provider !== "ollama") || typeof p.embeddingModel !== "string" || !p.embeddingModel.trim()
      || p.embeddingModel.length > 256 || p.embeddingModel.includes("\0")) return undefined;
    const model = p.knowledgeEmbeddingModel ?? p.embeddingModel;
    const dimension = p.vectorSize;
    if (typeof model !== "string" || !model.trim() || model.length > 256 || model.includes("\0")
      || !Number.isInteger(dimension) || dimension < 1 || dimension > 8192) return undefined;
    const queryPrefix = p.knowledgeEmbeddingQueryPrefix ?? (provider === "ollama" ? "search_query: " : "");
    const documentPrefix = p.knowledgeEmbeddingDocumentPrefix ?? (provider === "ollama" ? "search_document: " : "");
    if (typeof queryPrefix !== "string" || typeof documentPrefix !== "string" || queryPrefix.length > 512 || documentPrefix.length > 512
      || queryPrefix.includes("\0") || documentPrefix.includes("\0")) return undefined;
    const baseUrl = provider === "openrouter" ? "https://openrouter.ai/api/v1" : p.ollamaBaseUrl ?? "http://127.0.0.1:11434";
    if (typeof baseUrl !== "string" || !baseUrl || baseUrl.length > 2048) return undefined;
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return { provider, model, dimension, queryPrefix, documentPrefix, baseUrl: url.toString().replace(/\/$/, "") };
  } catch { return undefined; }
}
