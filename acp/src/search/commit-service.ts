import { Worker } from "node:worker_threads";
import { realpath } from "node:fs/promises";
import { commitProjectRoot } from "./commit-corpus.js";
import { parseCommitSearchRequest, type CommitSearchRequest, type CommitSearchResponse } from "./commit-contract.js";
import { embedCommitHTTP, embeddingIdentity, loadCommitEmbeddingConfig, loadCommitEmbeddingKey, SEMANTIC_NOTICE, validCommitVector,
  type CommitEmbedder, type CommitEmbeddingConfig } from "./commit-provider.js";
import type { SearchIndexRequest, SearchIndexResponse } from "./contract.js";
import { parseSearchIndexRequest } from "./request.js";
import { IndexActions } from "./index-actions.js";

type Request = CommitSearchRequest | SearchIndexRequest;
type Response = CommitSearchResponse | SearchIndexResponse;
const indexing = (request: Request): request is SearchIndexRequest => "source" in request;

export interface CommitSearchOptions {
  readonly loadConfig?: (cwd: string) => Promise<CommitEmbeddingConfig | undefined>;
  readonly loadKey?: () => Promise<string | undefined>;
  readonly embed?: CommitEmbedder;
  readonly lockWaitMs?: number;
}
/** One agent-owned instance; cancellation retains the writer until transport actually unwinds. */
export class DesktopCommitSearchService {
  private readonly options: CommitSearchOptions;
  private readonly active = new Map<AbortController, { requested: string; root?: string }>();
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly queryCache = new Map<string, number[][]>();
  private disposed = false;
  private readonly lifetime = new AbortController();
  private readonly indexActions = new IndexActions<SearchIndexResponse>();
  constructor(options: CommitSearchOptions = {}) { this.options = options; }
  changed(cwd: string): void {
    // Cancel all aliases of this project conservatively; no background reindexing.
    for (const [controller, project] of this.active) {
      if ([project.requested, project.root].some(path => path && (path === cwd || path.startsWith(cwd + "/") || cwd.startsWith(path + "/")))) controller.abort();
    }
    this.queryCache.clear();
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.lifetime.abort();
    for (const controller of this.active.keys()) controller.abort();
    await Promise.allSettled([...this.jobs]);
    await this.indexActions.settled();
    this.queryCache.clear();
  }
  query(request: CommitSearchRequest, signal: AbortSignal = new AbortController().signal): Promise<CommitSearchResponse> {
    request = parseCommitSearchRequest(request);
    return this.start(request, signal) as Promise<CommitSearchResponse>;
  }
  index(request: SearchIndexRequest, signal: AbortSignal = new AbortController().signal): Promise<SearchIndexResponse> {
    request = parseSearchIndexRequest(request);
    if (request.source !== "commits") return Promise.reject(new Error("Invalid commit indexing source"));
    return this.indexActions.run(request.cwd, signal, this.lifetime.signal,
      owned => this.start(request, owned) as Promise<SearchIndexResponse>);
  }
  private start(request: Request, signal: AbortSignal): Promise<Response> {
    if (this.disposed) return Promise.reject(new Error("Commit search disposed"));
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    this.active.set(controller, { requested: request.cwd });
    const job = this.perform(request, controller).finally(() => {
      signal.removeEventListener("abort", abort); this.active.delete(controller); this.jobs.delete(job);
    });
    this.jobs.add(job); return job;
  }
  private async config(root: string): Promise<CommitEmbeddingConfig | undefined> {
    try { return await (this.options.loadConfig ?? loadCommitEmbeddingConfig)(root); } catch { return undefined; }
  }
  private async perform(request: Request, controller: AbortController): Promise<Response> {
    const signal = controller.signal; signal.throwIfAborted();
    if (!indexing(request) && !request.query.trim()) return { results: [], notices: [] };
    let root: string;
    try { root = await realpath(await commitProjectRoot(request.cwd, signal)); }
    catch { signal.throwIfAborted(); return indexing(request)
      ? { source: "commits", complete: false, message: "Commit history unavailable (not a Git repository)." }
      : { results: [], notices: ["Commit history unavailable (not a Git repository)."] }; }
    this.active.set(controller, { requested: request.cwd, root });
    const previous = this.tails.get(root) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      signal.throwIfAborted();
      const config = await this.config(root);
      let key: string | undefined;
      try { if (config?.provider === "openrouter") key = await (this.options.loadKey ?? loadCommitEmbeddingKey)(); } catch { /* Local fallback. */ }
      const usable = config && (config.provider === "ollama" || (config.provider === "openrouter" && key)) ? config : undefined;
      signal.throwIfAborted();
      if (indexing(request) && !usable) return { source: "commits" as const, complete: false, message: SEMANTIC_NOTICE };
      return this.worker(request, root, usable, key, signal);
    });
    this.tails.set(root, work);
    try { return await work; }
    finally { if (this.tails.get(root) === work) this.tails.delete(root); }
  }
  private worker(request: Request, root: string, config: CommitEmbeddingConfig | undefined, key: string | undefined, signal: AbortSignal): Promise<Response> {
    const url = new URL(import.meta.url.endsWith(".ts") ? "./commit-worker.ts" : "./commit-worker.js", import.meta.url);
    // Production runs compiled JS. tsx registration is development/test-only.
    const worker = url.pathname.endsWith(".ts")
      ? new Worker(`import('tsx/esm/api').then(m => m.tsImport(${JSON.stringify(url.href)}, ${JSON.stringify(import.meta.url)}));`, { eval: true, workerData: { request, root, config, lockWaitMs: this.options.lockWaitMs ?? 5000 } })
      : new Worker(url, { workerData: { request, root, config, lockWaitMs: this.options.lockWaitMs ?? 5000 } });
    const abort = () => worker.postMessage({ type: "abort" });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const inflight = new Set<Promise<void>>();
    let result: Response | undefined;
    return new Promise((resolve, reject) => {
      worker.on("message", p => {
        if (p.type === "result") { result = p.value; return; }
        if (p.type === "failed") return;
        const op = (async () => {
          try {
            signal.throwIfAborted();
            const current = await this.config(root);
            if (!config || !current || embeddingIdentity(config) !== embeddingIdentity(current)) throw new Error(SEMANTIC_NOTICE);
            if (p.type === "validate") { worker.postMessage({ id: p.id, ok: true, value: true }); return; }
            if (p.type !== "embed" || !Array.isArray(p.input)) throw new Error(SEMANTIC_NOTICE);
            const cacheKey = embeddingIdentity(config) + "\0" + p.input[0];
            let vectors = p.query ? this.queryCache.get(cacheKey) : undefined;
            if (!vectors) vectors = await (this.options.embed ?? embedCommitHTTP)(p.input, config, key, signal);
            signal.throwIfAborted();
            const after = await this.config(root);
            if (!after || embeddingIdentity(after) !== embeddingIdentity(config) || vectors.length !== p.input.length || !vectors.every(v => validCommitVector(v, config.dimension))) throw new Error(SEMANTIC_NOTICE);
            if (p.query) {
              this.queryCache.delete(cacheKey); this.queryCache.set(cacheKey, vectors);
              while (this.queryCache.size > 64) this.queryCache.delete(this.queryCache.keys().next().value!);
            }
            worker.postMessage({ id: p.id, ok: true, value: vectors });
          } catch { worker.postMessage({ id: p.id, ok: false }); }
        })().finally(() => inflight.delete(op));
        inflight.add(op);
      });
      worker.once("error", () => { /* Exit is the ownership-release boundary. */ });
      worker.once("exit", () => {
        void Promise.allSettled([...inflight]).then(() => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) { reject(signal.reason); return; }
          resolve(result ?? (indexing(request) ? { source: "commits", complete: false, message: "Commit indexing unavailable." }
            : { results: [], notices: ["Commit search unavailable."] }));
        });
      });
    });
  }
}
