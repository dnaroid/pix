import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { openStore, snapshot, publish, queryStore, checkStorage } from "./native-store.mjs";
import { scanProject } from "./native-scan.mjs";
import { searchSemantic, indexSemantic, fuseRepositoryHits } from "./native-semantic.mjs";
import { repositoryEmbeddingSettings } from "./native-embedding-provider.mjs";

function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)
    || typeof request.query !== "string" || !request.query.trim() || request.query.length > 2048 || request.query.includes("\0")
    || !Array.isArray(request.sources) || !request.sources.length || request.sources.length > 2
    || !request.sources.every(source => source === "code" || source === "knowledge")
    || new Set(request.sources).size !== request.sources.length) throw new Error("Invalid request");
  if (Object.keys(request).some(key => !["query", "sources", "mode", "limit", "pathPrefix", "includeContent", "dedupeFile", "excludeTests", "includeTests"].includes(key))) throw new Error("Unknown request argument");
  if (request.mode !== undefined && !["lexical", "hybrid", "semantic"].includes(request.mode)) throw new Error("Invalid mode");
  if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100)) throw new Error("Invalid limit");
  if (request.pathPrefix !== undefined && (typeof request.pathPrefix !== "string" || !request.pathPrefix || request.pathPrefix.length > 1024
    || request.pathPrefix.includes("\\") || request.pathPrefix.includes("\0") || request.pathPrefix.startsWith("~")
    || request.pathPrefix.split("/").some(part => !part || part === "." || part === ".." || part.startsWith("-")))) throw new Error("Invalid path");
  for (const flag of ["includeContent", "dedupeFile", "excludeTests", "includeTests"]) {
    if (request[flag] !== undefined && typeof request[flag] !== "boolean") throw new Error("Invalid flag");
  }
  if (request.includeTests && request.excludeTests) throw new Error("Conflicting flags");
}

async function canonicalRoot(root) {
  if (typeof root !== "string" || !root || root.includes("\0")) throw new Error("Invalid root");
  root = path.resolve(root);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error("Unsafe root");
  return root;
}

async function refreshSnapshot(store, signal) {
  signal?.throwIfAborted();
  const previous = snapshot(store);
  const scan = await scanProject(store.root, previous, undefined, signal);
  signal?.throwIfAborted();
  await checkStorage(store.root, store.filename);
  signal?.throwIfAborted();
  const published = scan.complete && publish(store, previous, scan);
  return { previous, scan, published };
}

/** Explicit bounded document-only pass; no query embedding or ranking.
 * @returns {Promise<import('./native-contract.js').NativeIndexResponse>}
 */
export async function indexNative(root, request, dependencies = {}) {
  let store;
  const source = request?.source === "knowledge" ? "knowledge" : "code";
  const signal = AbortSignal.any([dependencies.signal ?? new AbortController().signal, AbortSignal.timeout(35000)]);
  try {
    if (!request || typeof request !== "object" || Array.isArray(request) || request.operation !== "index"
      || !["code", "knowledge"].includes(request.source)
      || Object.keys(request).some(key => !["operation", "source"].includes(key))) throw new Error("Invalid index request");
    signal.throwIfAborted();
    store = await openStore(await canonicalRoot(root));
    const { previous, scan, published } = await refreshSnapshot(store, signal);
    const generation = previous.generation + 1;
    if (!published || store.db.prepare("SELECT generation FROM pix_native_meta WHERE singleton=1").get().generation !== generation) {
      return { source, complete: false, message: "Native snapshot freshness is unverified; retry indexing. " + scan.notices.join(" ") };
    }
    const result = await indexSemantic(store, source, generation, { ...dependencies, signal });
    signal.throwIfAborted();
    if (store.db.prepare("SELECT generation FROM pix_native_meta WHERE singleton=1").get().generation !== generation) {
      return { source, complete: false, message: "Native snapshot changed during indexing; retry to verify current coverage. Cached embeddings are retained." };
    }
    const verified = ["ready", "partial"].includes(result.status.state);
    return { source, complete: verified && result.status.complete,
      ...(verified ? { indexed: result.status.indexed, total: result.status.total } : {}),
      ...(result.notices.length ? { message: result.notices.join(" ") } : {}) };
  } catch {
    return { source, complete: false, message: "Native indexing unavailable (invalid request, cancellation or unsafe storage); cached embeddings are retained." };
  } finally { store?.close(); }
}

/** Shared lexical-first engine; globally configured semantic enrichment, no SDK.
 * @returns {Promise<import('./native-contract.js').NativeSearchResponse>}
 */
export async function searchNative(root, request, dependencies = {}) {
  let store;
  const started = Date.now();
  const notices = [];
  try {
    validateRequest(request);
    request = { ...request, mode: request.mode ?? "hybrid", limit: request.limit ?? 10 };
    root = await canonicalRoot(root);
    store = await openStore(root);
    const { previous, scan, published } = await refreshSnapshot(store, dependencies.signal);
    notices.push(...scan.notices);
    let complete = !!published;
    if (scan.complete && !published) {
      notices.push("A newer native snapshot won the generation race; retry for verified freshness.");
    }
    const candidateRequest = request.mode === "lexical" ? request : { ...request, dedupeFile: false, limit: 100 };
    let result = queryStore(store, candidateRequest);
    const stale = !published || result.meta.generation !== previous.generation + 1;
    if (published && stale) { complete = false; notices.push("Native snapshot changed before query; freshness is unverified."); }
    if (result.capped) { complete = false; notices.push("Native query candidate limit reached; results are partial."); }
    let semantic;
    if (request.mode !== "lexical" && !stale) {
      semantic = await searchSemantic(store, request, result.meta.generation, { ...dependencies,
        signal: AbortSignal.any([dependencies.signal ?? new AbortController().signal, AbortSignal.timeout(Math.max(1, 35000 - (Date.now() - started)))]) });
      notices.push(...semantic.notices);
      if (semantic.status.enabled || request.mode === "semantic") complete &&= semantic.status.complete;
      if (store.db.prepare("SELECT generation FROM pix_native_meta WHERE singleton=1").get().generation !== result.meta.generation) {
        result = queryStore(store, candidateRequest);
        complete = false;
        notices.push("Native snapshot changed during semantic retrieval; current local matches returned.");
      }
    }
    const usableSemantic = semantic && ["ready", "partial"].includes(semantic.status.state);
    const semanticEnabled = semantic?.status.enabled ?? Boolean(await repositoryEmbeddingSettings(store.root));
    const hits = usableSemantic
      ? fuseRepositoryHits(request.mode === "semantic" ? [] : result.hits, semantic.hits, request)
      : result.hits.filter((hit, index, all) => !request.dedupeFile || all.findIndex(other => other.path === hit.path) === index).slice(0, request.limit);
    const response = { hits, notices, status: { backend: "native", complete,
      stale,
      semanticEnabled,
      mode: usableSemantic ? request.mode : "lexical", ...(semantic ? { semantic: semantic.status } : {}),
      generation: result.meta.generation, completedAt: result.meta.completed_at || undefined,
      scannedFiles: scan.scannedFiles, updatedFiles: scan.updatedFiles } };
    if (Buffer.byteLength(JSON.stringify(response)) > 480 * 1024) {
      response.status.complete = false;
      notices.push("Native output limit reached; results are partial.");
      while (response.hits.length && Buffer.byteLength(JSON.stringify(response)) > 480 * 1024) response.hits.pop();
    }
    return response;
  } catch {
    return { hits: [], notices: [...notices, "Native search unavailable (invalid request, unsafe storage or scan/query failure); results are incomplete."],
      status: { backend: "native", complete: false, stale: true } };
  } finally { store?.close(); }
}
