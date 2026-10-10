import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse, type ParseError } from "jsonc-parser";

/** The same pinned identity as ACP Search; vector caches from other models
 * must never be queried as if their cosine values were comparable. */
export const SEARCH_VECTOR_MODEL = "perplexity/pplx-embed-v1-0.6b";
export const SEARCH_VECTOR_DIMENSIONS = 1024;

export interface SemanticSearchOptions {
  /** Test/embedding-service substitution. Production reads user-global opt-ins
   * and shared SDK auth; it does not inherit ambient environment API keys. */
  consentPath?: string;
  authPath?: string;
  sessionMapPath?: string;
  embedQuery?: (query: string, key: string, signal: AbortSignal) => Promise<readonly number[]>;
  /** Test injection. Production uploads only bounded task title/description
   * projections, and only with the separate explicit Tasks opt-in. */
  embedTasks?: (texts: readonly string[], key: string, signal: AbortSignal) => Promise<readonly (readonly number[])[]>;
}

export type SemanticConsents = { tasks: boolean; sessions: boolean };

async function regularFile(path: string, limit: number): Promise<string | undefined> {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit) return;
  return readFile(path, "utf8");
}

export async function semanticConsents(options: SemanticSearchOptions, signal: AbortSignal): Promise<SemanticConsents> {
  signal.throwIfAborted();
  const source = await regularFile(options.consentPath ?? join(homedir(), ".config/pi/pix-desktop.jsonc"), 512 * 1024);
  if (!source) return { tasks: false, sessions: false };
  const errors: ParseError[] = [];
  const configuration: unknown = parse(source, errors, { allowTrailingComma: true });
  if (errors.length || !configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return { tasks: false, sessions: false };
  }
  const search = (configuration as Record<string, unknown>).search;
  if (!search || typeof search !== "object" || Array.isArray(search)) return { tasks: false, sessions: false };
  signal.throwIfAborted();
  const flags = search as Record<string, unknown>;
  return { tasks: flags.tasksSemanticEnabled === true, sessions: flags.sessionTitlesEnabled === true };
}

export async function semanticKey(options: SemanticSearchOptions, signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted();
  const source = await regularFile(options.authPath ?? join(getAgentDir(), "auth.json"), 512 * 1024);
  if (!source) return;
  let value: unknown;
  try { value = JSON.parse(source); } catch { return; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const entry = (value as Record<string, unknown>).openrouter;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
  const stored = entry as Record<string, unknown>;
  if (stored.type !== "api_key" || typeof stored.key !== "string" || !stored.key.trim() || stored.key.length > 10000) return;
  signal.throwIfAborted();
  return stored.key;
}

export function validSearchVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === SEARCH_VECTOR_DIMENSIONS
    && value.every(n => typeof n === "number" && Number.isFinite(n) && Number.isFinite(Math.fround(n)))
    && value.some(n => Math.fround(n) !== 0);
}

function decodeVectors(data: unknown, expectedCount: number): number[][] {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid search vector");
  const response = data as Record<string, unknown>;
  if (response.object !== "list" || ![SEARCH_VECTOR_MODEL, "pplx-embed-v1-0.6b"].includes(String(response.model))
    || !Array.isArray(response.data) || response.data.length !== expectedCount) throw new Error("Invalid search vector");
  const decoded: number[][] = new Array(expectedCount);
  for (const item of response.data) {
    if (!item || typeof item !== "object" || !Number.isSafeInteger(item.index)
      || item.index < 0 || item.index >= expectedCount || decoded[item.index]
      || item.object !== "embedding") throw new Error("Invalid search vector");
    let vector: unknown = item.embedding;
    if (typeof vector === "string") {
      if (vector.length !== 5464 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(vector)) {
        throw new Error("Invalid search vector");
      }
      const bytes = Buffer.from(vector, "base64");
      if (bytes.length !== SEARCH_VECTOR_DIMENSIONS * 4 || bytes.toString("base64") !== vector) throw new Error("Invalid search vector");
      vector = Array.from({ length: SEARCH_VECTOR_DIMENSIONS }, (_, i) => bytes.readFloatLE(i * 4));
    }
    if (!validSearchVector(vector)) throw new Error("Invalid search vector");
    decoded[item.index] = vector;
  }
  if (decoded.some(vector => !vector)) throw new Error("Invalid search vector");
  return decoded;
}

/** Single bounded provider batch. Task-content callers must verify consent
 * and the current SQLite snapshot before and after invoking this function. */
async function embedBatch(inputs: readonly string[], key: string, signal: AbortSignal): Promise<number[][]> {
  if (!inputs.length || inputs.length > 16 || inputs.some(input => !input.trim() || input.length > 2000)) {
    throw new Error("Invalid semantic embedding batch");
  }
  const owned = AbortSignal.any([signal, AbortSignal.timeout(9_000)]);
  const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST", signal: owned,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: SEARCH_VECTOR_MODEL, input: inputs, encoding_format: "float" }),
  });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Search provider unavailable"); }
  const reader = response.body.getReader();
  let bytes = 0;
  const buffers: Uint8Array[] = [];
  try {
    while (true) {
      owned.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 1_300_000) throw new Error("Search vector too large");
      buffers.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return decodeVectors(JSON.parse(Buffer.concat(buffers).toString("utf8")), inputs.length);
}

/** One query embedding (no task/session bodies transmitted by this operation). */
export async function embedSemanticQuery(query: string, key: string, signal: AbortSignal): Promise<number[]> {
  return (await embedBatch([query], key, signal))[0]!;
}

/** Explicit on-demand semantic Tasks indexing, authorized by prior user opt-in. */
export async function embedTaskTexts(texts: readonly string[], key: string, signal: AbortSignal): Promise<number[][]> {
  return embedBatch(texts, key, signal);
}
