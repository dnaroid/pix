import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { openStore, snapshot, publish, queryStore, checkStorage } from "./native-store.mjs";
import { scanProject } from "./native-scan.mjs";
import { searchSemantic, indexSemantic, fuseRepositoryHits, MAX_CHUNKS_PER_SEARCH } from "./native-semantic.mjs";
import { repositoryEmbeddingSettings } from "./native-embedding-provider.mjs";
import { SourceExtensionConfigurationError } from "./native-source-config.mjs";
import { repositoryRerankerSettings, rerankNativeHits, MAX_RERANK_CANDIDATES } from "./native-reranker.mjs";
import { verifyRerankerCandidates } from "./native-reranker-context.mjs";
import { claimWork } from "./source-work.mjs";
import { sourceEnabled, readSourcePolicy, requireSourceEnabled, withSourcePolicy } from "./source-policy.mjs";

function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)
    || typeof request.query !== "string" || !request.query.trim() || request.query.length > 2048 || request.query.includes("\0")
    || !Array.isArray(request.sources) || !request.sources.length || request.sources.length > 2
    || !request.sources.every(source => source === "code" || source === "knowledge")
    || new Set(request.sources).size !== request.sources.length) throw new Error("Invalid request");
  if (Object.keys(request).some(key => !["query", "sources", "mode", "limit", "pathPrefix", "includeContent", "dedupeFile", "excludeTests", "includeTests", "skipRerank"].includes(key))) throw new Error("Unknown request argument");
  if (request.mode !== undefined && !["lexical", "hybrid", "semantic"].includes(request.mode)) throw new Error("Invalid mode");
  if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100)) throw new Error("Invalid limit");
  if (request.pathPrefix !== undefined && (typeof request.pathPrefix !== "string" || !request.pathPrefix || request.pathPrefix.length > 1024
    || request.pathPrefix.includes("\\") || request.pathPrefix.includes("\0") || request.pathPrefix.startsWith("~")
    || request.pathPrefix.split("/").some(part => !part || part === "." || part === ".." || part.startsWith("-")))) throw new Error("Invalid path");
  for (const flag of ["includeContent", "dedupeFile", "excludeTests", "includeTests", "skipRerank"]) {
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
  const scan = await scanProject(store.root, previous, undefined, signal, store.source);
  await requireSourceEnabled(store.root, store.source, signal);
  signal?.throwIfAborted();
  await checkStorage(store.root, store.filename);
  signal?.throwIfAborted();
  const published = scan.complete && publish(store, previous, scan);
  const changed = previous.files.size !== scan.files.size || [...scan.files].some(([name, file]) => previous.files.get(name) !== file.hash);
  return { previous, scan, published, generation: previous.generation + (changed ? 1 : 0) };
}

/** Explicit document-only drain; no query embedding or ranking.
 * @returns {Promise<import('./native-contract.js').NativeIndexResponse>}
 */
export async function indexNative(root, request, dependencies = {}) {
  try {
    return await withSourcePolicy(root, dependencies.signal ?? new AbortController().signal, signal =>
      indexEnabledNative(root, request, { ...dependencies, signal }));
  } catch {
    // The policy fence runs outside the store's try/finally as well. Cancellation
    // or a changed policy must still use the document-index response contract,
    // without reporting stale coverage or exposing raw errors.
    return unavailableIndex(request?.source === "knowledge" ? "knowledge" : "code");
  }
}
function unavailableIndex(source) {
  return { source, complete: false, message: "Native indexing unavailable (invalid request, cancellation or unsafe storage); cached embeddings are retained." };
}
async function indexEnabledNative(root, request, dependencies) {
  let store;
  let work;
  let success = false;
  const source = request?.source === "knowledge" ? "knowledge" : "code";
  const signal = dependencies.signal ?? new AbortController().signal;
  try {
    if (!request || typeof request !== "object" || Array.isArray(request) || request.operation !== "index"
      || !["code", "knowledge"].includes(request.source)
      || Object.keys(request).some(key => !["operation", "source"].includes(key))) throw new Error("Invalid index request");
    signal.throwIfAborted();
    root = await canonicalRoot(root);
    if (!await sourceEnabled(root, source)) return { source, complete: false, message: "Search source is disabled for this project" };
    store = await openStore(root, source);
    work = await claimWork(store.db, signal, { retry: true });
    const { scan, published, generation } = await refreshSnapshot(store, signal);
    if (!published || store.db.prepare("SELECT generation FROM pix_native_meta WHERE singleton=1").get().generation !== generation) {
      return { source, complete: false, message: "Native snapshot freshness is unverified; retry indexing. " + scan.notices.join(" ") };
    }
    const result = await indexSemantic(store, source, generation, { ...dependencies, signal, work });
    success = result.status.state !== "unavailable";
    signal.throwIfAborted();
    if (store.db.prepare("SELECT generation FROM pix_native_meta WHERE singleton=1").get().generation !== generation) {
      return { source, complete: false, message: "Native snapshot changed during indexing; retry to verify current coverage. Cached embeddings are retained." };
    }
    const verified = ["ready", "partial"].includes(result.status.state);
    return { source, complete: verified && result.status.complete,
      ...(verified ? { indexed: result.status.indexed, total: result.status.total } : {}),
      ...(result.notices.length ? { message: result.notices.join(" ") } : {}) };
  } catch (error) {
    if (error instanceof SourceExtensionConfigurationError) return { source, complete: false, message: error.message };
    return unavailableIndex(source);
  } finally { if (work) await work.release(success).catch(() => {}); store?.close(); }
}

/** Shared lexical-first engine; globally configured semantic enrichment, no SDK.
 * @returns {Promise<import('./native-contract.js').NativeSearchResponse>}
 */
export async function searchNative(root, request, dependencies = {}) {
  return withSourcePolicy(root, dependencies.signal ?? new AbortController().signal, signal =>
    searchEnabledNative(root, request, { ...dependencies, signal }));
}
async function searchEnabledNative(root, request, dependencies) {
  try { validateRequest(request); }
  catch { return { hits: [], notices: ["Invalid native search request"], limitNotices: [], status: { backend: "native", complete: false, completeForSelection: false, stale: true } }; }
  const reranker = await repositoryRerankerSettings();
  const reranking = !!reranker && request.mode !== "lexical" && !request.skipRerank;
  const sourceStates = new Map();
  const retrievalRequest = reranking ? { ...request, limit: MAX_RERANK_CANDIDATES, dedupeFile: false, includeContent: true } : request;
  dependencies = { ...dependencies, sourceStates };
  const response = await retrieveSources(root, retrievalRequest, dependencies);
  response.status.rerankerEnabled = !!reranker;
  if (reranking && !response.status.stale) {
    const candidates = response.hits.slice(0, MAX_RERANK_CANDIDATES);
    const checkCurrent = (signal, verifyContent) => verifyRerankerCandidates(root, candidates, sourceStates, signal, verifyContent);
    const ranked = await rerankNativeHits(request.query, response.hits, reranker, dependencies, checkCurrent);
    response.hits = ranked.hits;
    response.notices.push(...ranked.notices);
    response.limitNotices.push(...ranked.limitNotices);
    response.status.completeForSelection = response.status.completeForSelection === true && ranked.completeForSelection === true;
    if (ranked.limitNotices.length) response.status.complete = false;
  }
  const seen = new Set();
  response.hits = response.hits.filter(hit => {
    if (request.dedupeFile && seen.has(hit.path)) return false;
    seen.add(hit.path); return true;
  }).slice(0, request.limit ?? 10).map(hit => {
    if (request.includeContent) return hit;
    const { content, ...compact } = hit; return compact;
  });
  if (request.skipRerank && !response.status.stale) {
    response.rerankContext = Object.fromEntries([...sourceStates].map(([source, state]) => [source,
      { generation: state.generation, hashes: Object.fromEntries([...state.hashes].filter(([name]) => response.hits.some(hit => hit.kind === source && hit.path === name))) }]));
  }
  if (Buffer.byteLength(JSON.stringify(response)) > 480 * 1024) {
    response.status.complete = false;
    const notice = "Native output limit reached; results are partial.";
    response.notices.push(notice);
    response.limitNotices.push(notice);
    while (response.hits.length && Buffer.byteLength(JSON.stringify(response)) > 480 * 1024) response.hits.pop();
  }
  return response;
}
async function retrieveSources(root, request, dependencies) {
  if (request.sources.length === 1) return searchSource(root, request, dependencies);
  const uploadBudget = { remaining: MAX_CHUNKS_PER_SEARCH };
  const results = await Promise.all(request.sources.map(source => searchSource(root, { ...request, sources: [source], limit: 100 }, { ...dependencies, uploadBudget })));
  const hits = results.flatMap(result => result.hits).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine);
  const seen = new Set();
  const semantic = results.map(result => result.status.semantic).filter(Boolean);
  const combinedSemantic = semantic.length ? { ...semantic[0],
    complete: semantic.every(status => status.complete),
    state: semantic.some(status => status.state === "unavailable") ? "unavailable"
      : semantic.every(status => status.state === "ready") ? "ready"
      : semantic.every(status => status.state === "disabled") ? "disabled" : "partial",
    indexed: semantic.reduce((n, status) => n + (status.indexed ?? 0), 0), total: semantic.reduce((n, status) => n + (status.total ?? 0), 0) } : undefined;
  return { hits: hits.filter(hit => { if (request.dedupeFile && seen.has(hit.path)) return false; seen.add(hit.path); return true; }).slice(0, request.limit ?? 10),
    notices: [...new Set(results.flatMap(result => result.notices))],
    limitNotices: [...new Set(results.flatMap(result => result.limitNotices))],
    status: { ...results[0].status, ...(combinedSemantic ? { semantic: combinedSemantic } : {}), complete: results.every(result => result.status.complete), stale: results.some(result => result.status.stale),
      completeForSelection: results.every(result => result.status.completeForSelection === true),
      scannedFiles: results.reduce((n, result) => n + (result.status.scannedFiles ?? 0), 0), updatedFiles: results.reduce((n, result) => n + (result.status.updatedFiles ?? 0), 0) } };
}
async function searchSource(root, request, dependencies = {}) {
  let store;
  let work;
  let success = false;
  const started = Date.now();
  const notices = [], limitNotices = [];
  try {
    validateRequest(request);
    request = { ...request, mode: request.mode ?? "hybrid", limit: request.limit ?? 10 };
    root = await canonicalRoot(root);
    const policy = await readSourcePolicy(root);
    if (policy.error) return { hits: [], notices: [policy.error], limitNotices, status: { backend: "native", complete: false, completeForSelection: false, stale: true } };
    if (!policy.enabled[request.sources[0]]) return { hits: [], notices: [`${request.sources[0]}: disabled for this project`],
      limitNotices, status: { backend: "native", complete: true, completeForSelection: true, stale: false } };
    store = await openStore(root, request.sources[0]);
    if (request.mode !== "lexical") work = await claimWork(store.db, dependencies.signal ?? new AbortController().signal);
    const { scan, published, generation } = await refreshSnapshot(store, dependencies.signal);
    notices.push(...scan.notices);
    let complete = !!published, completeForSelection = !!published;
    if (scan.complete && !published) {
      notices.push("A newer native snapshot won the generation race; retry for verified freshness.");
    }
    const candidateRequest = request.mode === "lexical" ? request : { ...request, dedupeFile: false, limit: 100 };
    let result = queryStore(store, candidateRequest);
    const stale = !published || result.meta.generation !== generation;
    if (published && stale) { complete = completeForSelection = false; notices.push("Native snapshot changed before query; freshness is unverified."); }
    if (result.capped) {
      complete = false;
      const notice = "Native query candidate limit reached; results are partial.";
      notices.push(notice); limitNotices.push(notice);
    }
    let semantic;
    if (request.mode !== "lexical" && !stale) {
      semantic = await searchSemantic(store, request, result.meta.generation, { ...dependencies, work,
        signal: AbortSignal.any([dependencies.signal ?? new AbortController().signal, AbortSignal.timeout(Math.max(1, 35000 - (Date.now() - started)))]) });
      notices.push(...semantic.notices);
      if (semantic.status.enabled || request.mode === "semantic") complete &&= semantic.status.complete;
      if (semantic.status.enabled || request.mode === "semantic" || semantic.status.state !== "disabled")
        completeForSelection &&= semantic.status.complete === true && semantic.status.state === "ready";
      if (store.db.prepare("SELECT generation FROM pix_native_meta WHERE singleton=1").get().generation !== result.meta.generation) {
        result = queryStore(store, candidateRequest);
        complete = completeForSelection = false;
        notices.push("Native snapshot changed during semantic retrieval; current local matches returned.");
      }
    }
    const usableSemantic = semantic && ["ready", "partial"].includes(semantic.status.state);
    const semanticEnabled = semantic?.status.enabled ?? Boolean(await repositoryEmbeddingSettings(store.root));
    const hits = usableSemantic
      ? fuseRepositoryHits(request.mode === "semantic" ? [] : result.hits, semantic.hits, request)
      : result.hits.filter((hit, index, all) => !request.dedupeFile || all.findIndex(other => other.path === hit.path) === index).slice(0, request.limit);
    const response = { hits, notices, limitNotices, status: { backend: "native", complete, completeForSelection,
      stale,
      semanticEnabled,
      mode: usableSemantic ? request.mode : "lexical", ...(semantic ? { semantic: semantic.status } : {}),
      generation: result.meta.generation, completedAt: result.meta.completed_at || undefined,
      scannedFiles: scan.scannedFiles, updatedFiles: scan.updatedFiles } };
    dependencies.sourceStates?.set(request.sources[0], { generation: result.meta.generation,
      hashes: new Map(hits.map(hit => [hit.path, store.db.prepare("SELECT hash FROM pix_native_files WHERE path=?").get(hit.path)?.hash])) });
    success = semantic?.status.state !== "unavailable";
    return response;
  } catch (error) {
    if (error instanceof SourceExtensionConfigurationError) notices.push(error.message);
    return { hits: [], notices: [...notices, "Native search unavailable (invalid request, unsafe storage or scan/query failure); results are incomplete."], limitNotices,
      status: { backend: "native", complete: false, completeForSelection: false, stale: true } };
  } finally { if (work) await work.release(success).catch(() => {}); store?.close(); }
}
