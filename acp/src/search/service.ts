import { resolve } from "node:path";
import type { SessionMapRecord } from "../acp/session-map.js";
import type { LocalSearchHit, SearchConfigRequest, SearchIndexRequest, SearchIndexResponse, SearchSyncRequest, SearchQueryRequest, SearchQueryResponse, SearchStatus, SessionSearchHit, SemanticTasksRequest, SemanticTasksResponse, SemanticTaskHit } from "./contract.js";
import { SearchPreferences, sharedSearchAuth, semanticEmbeddingIdentity, type SemanticEmbeddingConfig, type SearchAuth } from "./config.js";
import { SESSION_CHUNK_FORMAT } from "./session-chunk-store.js";
import { parseSearchConfigRequest, parseSearchIndexRequest, parseSearchSyncRequest } from "./request.js";
import { bounded } from "./bounded.js";
import { hashText, lexicalScore, settingsDocuments, settingsFingerprint, type SearchDocument } from "./documents.js";
import { cosine, embedOpenRouter, validVector, type Embedder } from "./embeddings.js";
import { SearchIndexBusyError, SearchIndexStore, emptyIndex, type CachedIndex } from "./index-store.js";
import { sessionTitleHits } from "./session-titles.js";
import { namedSessionTitles, type NamedSessionTitle } from "./session-index.js";
import { readTaskSemanticCorpus } from "./task-corpus.js";
import { SettingsTaskIndexer } from "./settings-task-indexer.js";
import { withProviderSlot } from "./source-work.js";
import type { TaskChangeWatcher } from "./task-watcher.js";
import { SearchCacheCompatibilityError } from "./embedding-cache.js";
import { IndexActions } from "./index-actions.js";
import { DesktopSessionChunks, sessionChunkHits, transcriptCandidates, indexedSessionRecords } from "./session-chunk-service.js";
import { hasSessionChunkVectors } from "./session-chunks.js";
import { SessionIdlePolicy, SessionIndexDeferred } from "./session-idle.js";
import { readSourcePolicy, sourceEnabled, requireSourceEnabled, watchSourcePolicy, type SourceSelection } from "./source-policy.js";
import type { SearchSetting } from "./contract.js";
import { BackgroundSessionDiscovery, hydrateBackgroundTitle, type BackgroundSessionRecord } from "./background-session-discovery.js";
import { transcriptUnchanged } from "./session-transcript.js";
import { beginSessionSweep, completeSessionSweep } from "./session-watermark.js";

const PROVIDER_WARNING = "Semantic settings search unavailable; local search remains available";
const SESSION_PROVIDER_WARNING = "Semantic session-title search unavailable; local search remains available";
const TASK_PROVIDER_WARNING = "Semantic task search unavailable; local task search remains available";
const DISCOVERY_ERROR = "Session title discovery timed out or failed";
export class SearchUnavailableError extends Error {}
export type SearchIndexDiagnostic = {
  cwd: string;
  source: SearchIndexRequest["source"];
  complete: boolean;
  indexed?: number;
  total?: number;
  durationMs: number;
  /** Fixed metadata only: never include provider messages or session content. */
  phase?: "authorization" | "documents" | "discovery" | "titles" | "chunks" | "finalize";
  reason?: "unconfigured" | "incomplete_coverage" | "discovery_failed" | "operation_failed";
};
interface Workspace {
  enabled: SourceSelection;
  policyRevision?: string;
  policyError?: string;
  catalogue?: SearchSetting[];
  unwatchPolicy(): void;
  cwd: string;
  controller: AbortController;
  cache: CachedIndex;
  settings: SearchDocument[];
  namedSessions: NamedSessionTitle[];
  namedRevision: number;
  refresh: Promise<unknown>;
  sessionsEmpty?: boolean;
  sourceStatusAt?: number;
  statusDiscovery?: Promise<readonly SessionMapRecord[]>;
  background?: SettingsTaskIndexer;
  sessionWorker?: Promise<void>;
  chunks?: DesktopSessionChunks;
  queryVectors: Map<string, number[]>;
  indexError?: string;
  error?: string;
}
export interface SearchServiceOptions {
  sessionRecords?(cwd: string, signal: AbortSignal): Promise<readonly SessionMapRecord[]>;
  discover(cwd: string, signal: AbortSignal, strict?: boolean): Promise<readonly SessionMapRecord[]>;
  discoverBackground?(cwd: string, signal: AbortSignal): Promise<readonly BackgroundSessionRecord[]>;
  sessionSnapshot?(cwd: string, signal: AbortSignal): Promise<string>;
  preferences?: SearchPreferences;
  auth?: SearchAuth;
  discoveryTimeoutMs?: number;
  store?: SearchIndexStore;
  embed?: Embedder;
  watchTasks?: TaskChangeWatcher;
  watchSourcePolicy?: typeof watchSourcePolicy;
  taskDebounceMs?: number;
  /** Opt-in metadata only; never include source documents, queries or provider responses. */
  onIndexDiagnostic?: (record: SearchIndexDiagnostic) => void;
}
/** Session public-text chunks and saved names share source-owned caches. */
export class DesktopSearchService {
  private readonly preferences: SearchPreferences;
  private readonly auth: SearchAuth;
  private readonly store: SearchIndexStore;
  private readonly embed: Embedder;
  private workspace: Workspace | undefined;
  private activationPath: string | undefined;
  private activationRevision = 0;
  private epoch = 0;
  private network = new AbortController();
  private enabled = false;
  private sessionTitlesEnabled = false;
  private tasksSemanticEnabled = false;
  private keyAvailable = false;
  private embeddingConfig: SemanticEmbeddingConfig | undefined;
  private consentRevision = 0;
  private catalogueRevision = 0;
  private indexCatalogue: { revision: number; fingerprint: string } | undefined;
  private disposed = false;
  private configQueue: Promise<void> = Promise.resolve();
  private readonly retired = new Set<Promise<void>>();
  private readonly activity = new Map<string, SessionIdlePolicy>();
  private readonly statusCatalog = new BackgroundSessionDiscovery(async () => []);
  private idlePolicy(cwd: string): SessionIdlePolicy {
    const root = resolve(cwd);
    let policy = this.activity.get(root);
    if (!policy) { policy = new SessionIdlePolicy(root); this.activity.set(root,policy); }
    return policy;
  }
  async sessionActivity(cwd: string, nativeId: string, running: boolean): Promise<void> {
    if (this.disposed) return;
    await this.idlePolicy(cwd).observe(nativeId,running);
    if (this.workspace?.cwd === resolve(cwd) && this.workspace.enabled.sessions) this.chunkIndexer(this.workspace).changed();
  }
  private readonly indexActions = new IndexActions<SearchIndexResponse>();
  constructor(private readonly options: SearchServiceOptions) {
    this.preferences = options.preferences ?? new SearchPreferences();
    this.auth = options.auth ?? sharedSearchAuth();
    this.store = options.store ?? new SearchIndexStore();
    this.embed = options.embed ?? embedOpenRouter;
  }
  private revoke(): void {
    this.epoch++; this.network.abort(); this.network = new AbortController();
    this.workspace?.queryVectors.clear();
    if (this.workspace) {
      this.workspace.cache = emptyIndex();
      if (this.workspace.background) {
        const operation = this.workspace.background.dispose().finally(() => this.retired.delete(operation));
        this.retired.add(operation); delete this.workspace.background;
      }
      if (this.workspace.chunks) {
        const operation = this.workspace.chunks.dispose().finally(() => this.retired.delete(operation));
        this.retired.add(operation); delete this.workspace.chunks;
      }
    }
  }
  private current(w: Workspace, epoch = this.epoch): boolean {
    return !this.disposed && this.workspace === w && !w.controller.signal.aborted && this.epoch === epoch;
  }
  private status(): SearchStatus {
    const sources = { settings: this.workspace?.background?.indexing.settings ?? false,
      tasks: this.workspace?.background?.indexing.tasks ?? false, sessions: Boolean(this.workspace?.sessionWorker || this.workspace?.chunks?.indexing) };
    const sourceErrors = { ...this.workspace?.background?.errors,
      ...(this.workspace?.indexError ? { sessions: this.workspace.indexError } : {}) };
    const error = this.workspace?.policyError ?? this.workspace?.indexError ?? sourceErrors.settings ?? sourceErrors.tasks ?? this.workspace?.error;
    return { enabled: this.enabled, sessionTitlesEnabled: this.sessionTitlesEnabled, tasksSemanticEnabled: this.tasksSemanticEnabled,
      keyAvailable: this.keyAvailable, indexing: Object.values(sources).some(Boolean), indexingSources: sources,
      checkingSources: this.workspace?.background?.checking ?? { tasks: false },
      ...(this.workspace?.sessionsEmpty !== undefined ? { sessionsEmpty: this.workspace.sessionsEmpty } : {}),
      ...(Object.keys(sourceErrors).length ? { sourceErrors } : {}), ...(error ? { error } : {}) };
  }
  private async consent(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const revision = ++this.consentRevision;
    let config = await this.preferences.embedding();
    let keyAvailable = config?.provider === "ollama";
    try { if (config?.provider === "openrouter") keyAvailable = await this.auth.available(signal); }
    catch { keyAvailable = false; if (this.workspace) this.workspace.error = "Search credentials unavailable; local search remains available"; }
    signal.throwIfAborted();
    // Credential lookup may be asynchronous; do not authorize an obsolete snapshot.
    const after = await this.preferences.embedding();
    if ((config && semanticEmbeddingIdentity(config)) !== (after && semanticEmbeddingIdentity(after))) {
      keyAvailable = after?.provider === "ollama";
      config = after;
    }
    signal.throwIfAborted();
    const identity = config ? semanticEmbeddingIdentity(config) : undefined;
    const prior = this.embeddingConfig ? semanticEmbeddingIdentity(this.embeddingConfig) : undefined;
    // A superseded read cannot mutate shared state or authorize a different snapshot.
    if (revision !== this.consentRevision) return Boolean(config) && keyAvailable && identity === prior && !this.disposed;
    if (identity !== prior || (this.keyAvailable && !keyAvailable)) {
      this.revoke();
      if (this.workspace) delete this.workspace.error;
    }
    this.embeddingConfig = config;
    this.enabled = this.sessionTitlesEnabled = this.tasksSemanticEnabled = Boolean(config);
    this.keyAvailable = keyAvailable;
    return this.enabled && this.keyAvailable && !this.disposed;
  }
  private async activate(cwd: string): Promise<Workspace> {
    if (this.disposed) throw new SearchUnavailableError("Search unavailable");
    const path = resolve(cwd);
    if (this.activationPath !== path) { this.activationPath = path; this.activationRevision++; }
    const revision = this.activationRevision;
    const policy = await readSourcePolicy(path);
    if (this.disposed || revision !== this.activationRevision) throw new SearchUnavailableError("Search workspace changed");
    if (this.workspace?.cwd === path) {
      const w = this.workspace;
      if (w.policyRevision === policy.revision && JSON.stringify(w.enabled) === JSON.stringify(policy.enabled)) {
        w.controller.signal.throwIfAborted();
        return w;
      }
    }
    const previous = this.workspace;
    const sameProject = previous?.cwd === path;
    if (!sameProject) previous?.unwatchPolicy();
    previous?.controller.abort(); this.revoke();
    const w: Workspace = { cwd: path, controller: new AbortController(), cache: emptyIndex(), settings: [],
      namedSessions: [], namedRevision: 0, refresh: Promise.resolve(), queryVectors: new Map(), enabled: policy.enabled,
      ...(policy.revision !== undefined ? { policyRevision: policy.revision } : {}),
      ...(policy.error ? { policyError: policy.error } : {}),
      ...(sameProject ? { settings: previous.settings, ...(previous.catalogue ? { catalogue: previous.catalogue } : {}) } : {}),
      unwatchPolicy: sameProject ? previous.unwatchPolicy : () => {} };
    this.workspace = w;
    if (!sameProject) w.unwatchPolicy = (this.options.watchSourcePolicy ?? watchSourcePolicy)(path, () => {
      const current = this.workspace;
      if (current?.cwd !== path || this.disposed) return;
      current.unwatchPolicy(); current.controller.abort(); this.revoke(); this.workspace = undefined;
      void this.sync({ cwd: path, settings: current.catalogue ?? [] }).catch(() => {});
    });
    w.controller.signal.throwIfAborted();
    return w;
  }
  async config(request: SearchConfigRequest, signal = new AbortController().signal): Promise<SearchStatus> {
    request = parseSearchConfigRequest(request);
    const operation = this.configQueue.catch(() => {}).then(async () => {
      if (this.disposed) return;
      const w = await this.activate(request.cwd);
      const owned = AbortSignal.any([signal, w.controller.signal]);
      try {
        owned.throwIfAborted();
        await this.consent(owned);
      } catch {
        owned.throwIfAborted();
        throw new SearchUnavailableError("Search configuration unavailable");
      }
      // Reading status/config never starts provider work.
      if (w.enabled.sessions && request.includeSourceStatus && (w.sourceStatusAt === undefined || Date.now() - w.sourceStatusAt >= 30_000)) {
        try {
          // Activity polling must not hydrate every transcript via SDK discovery.
          // An optional empty-source hint has a smaller budget than the UI read.
          if (w.statusDiscovery) throw new Error("Previous status discovery is still settling");
          const records = await bounded(owned, 1000, metadataSignal => {
            const pending = Promise.resolve().then(() => this.options.discoverBackground?.(w.cwd, metadataSignal)
              ?? this.statusCatalog.list(w.cwd, metadataSignal));
            w.statusDiscovery = pending;
            void pending.finally(() => { if (w.statusDiscovery === pending) delete w.statusDiscovery; }).catch(() => {});
            return pending;
          });
          owned.throwIfAborted();
          w.sessionsEmpty = records.length === 0;
        } catch {
          owned.throwIfAborted();
          delete w.sessionsEmpty;
        }
        w.sourceStatusAt = Date.now();
      }
    });
    this.configQueue = operation;
    await operation;
    signal.throwIfAborted();
    if (request.includeSessionSnapshot) {
      let sessionSnapshot: string | undefined;
      try {
        sessionSnapshot = await bounded(signal, 1500, owned =>
          this.options.sessionSnapshot?.(request.cwd, owned) ?? this.statusCatalog.snapshot(request.cwd, owned));
      } catch {
        // A snapshot only accelerates native freshness checks. Its own deadline
        // or I/O failure must not turn an otherwise healthy status read into an
        // ACP error. Caller cancellation still owns the request.
        signal.throwIfAborted();
      }
      return { ...this.status(), ...(sessionSnapshot !== undefined ? { sessionSnapshot } : {}) };
    }
    return this.status();
  }
  private background(w: Workspace): SettingsTaskIndexer | undefined {
    if (!this.current(w) || !this.embeddingConfig || !this.enabled || !this.keyAvailable) return undefined;
    return w.background ??= new SettingsTaskIndexer({ cwd: w.cwd,
      signal: AbortSignal.any([w.controller.signal, this.network.signal]), config: this.embeddingConfig,
      store: this.store, embed: (inputs, signal, domain) => this.vectors(inputs, signal, domain),
      enabled: source => w.enabled[source],
      authorized: async (signal, source) => await sourceEnabled(w.cwd, source, w.policyRevision) && await this.consent(signal),
      watchTasks: this.options.watchTasks, debounceMs: this.options.taskDebounceMs,
      completed: source => {
        if (this.current(w) && source === "settings" && w.error === PROVIDER_WARNING) delete w.error;
      } });
  }
  /** Explicit workspace ownership/catalogue supply. Never waits for provider batches. */
  async sync(request: SearchSyncRequest, caller = new AbortController().signal): Promise<SearchStatus> {
    request = parseSearchSyncRequest(request);
    caller.throwIfAborted();
    const revision = ++this.catalogueRevision;
    const w = await this.activate(request.cwd);
    const signal = AbortSignal.any([caller, w.controller.signal]);
    await this.consent(signal);
    signal.throwIfAborted();
    if (!this.current(w)) throw new SearchUnavailableError("Search unavailable");
    if (revision !== this.catalogueRevision) return this.status();
    w.settings = settingsDocuments(request.settings);
    this.background(w)?.sync(request.settings);
    w.catalogue = [...request.settings];
    if (w.enabled.sessions) this.chunkIndexer(w).changed();
    return this.status();
  }
  /** Explicit document-only indexing. This is deliberately not a search query or sync. */
  async index(request: SearchIndexRequest, caller = new AbortController().signal): Promise<SearchIndexResponse> {
    request = parseSearchIndexRequest(request);
    if (request.source === "commits") throw new SearchUnavailableError("Commit indexing uses the commit worker");
    caller.throwIfAborted();
    const documents = request.source === "settings" ? settingsDocuments(request.settings!) : [];
    const fingerprint = settingsFingerprint(documents);
    const revision = request.source === "settings" ? ++this.catalogueRevision : this.catalogueRevision;
    if (request.source === "settings") this.indexCatalogue = { revision, fingerprint };
    const w = await this.activate(request.cwd);
    await requireSourceEnabled(w.cwd, request.source, caller, w.policyRevision);
    const key = JSON.stringify([w.cwd, request.source, fingerprint]);
    // Coalesce before consent as well: two first-use clicks must not supersede
    // one another's authorization reads and return a fictitious missing config.
    return this.indexActions.run(key, caller, w.controller.signal, async operationSignal => {
      const source = request.source;
      const startedAt = Date.now();
      let phase: NonNullable<SearchIndexDiagnostic["phase"]> = "authorization";
      const finish = (result: SearchIndexResponse, reason: SearchIndexDiagnostic["reason"] = "incomplete_coverage"): SearchIndexResponse => {
        if (!operationSignal.aborted) {
          try {
            this.options.onIndexDiagnostic?.({ cwd: w.cwd, source, complete: result.complete,
              ...(result.indexed === undefined ? {} : { indexed: result.indexed }),
              ...(result.total === undefined ? {} : { total: result.total }),
              durationMs: Date.now() - startedAt,
              ...(result.complete ? {} : { phase, reason }) });
          } catch { /* Diagnostics cannot alter search results. */ }
        }
        return result;
      };
      if (!await bounded(operationSignal, undefined, signal => this.consent(signal))) return finish({ source, complete: false,
        message: "Configure an embedding model and its credential to index this source" }, "unconfigured");
      const owned = AbortSignal.any([operationSignal, this.network.signal]);
      owned.throwIfAborted();
      const config = this.embeddingConfig!;
      const epoch = this.epoch;
      try {
        const sweep = source === "sessions" ? await beginSessionSweep(w.cwd,`${SESSION_CHUNK_FORMAT}:${semanticEmbeddingIdentity(config)}`,owned) : undefined;
        let indexed = 0, total = 0;
        let diagnostics: SearchIndexResponse["diagnostics"];
        let namedRevision: number | undefined;
        if (source === "settings" || source === "tasks") {
          phase = "documents";
          if (source === "settings") {
            if (revision !== this.catalogueRevision && (this.indexCatalogue?.revision !== this.catalogueRevision
              || this.indexCatalogue.fingerprint !== fingerprint)) throw new SearchUnavailableError("Settings catalogue changed; retry indexing");
            w.settings = documents;
          }
          const background = this.background(w);
          if (!background) throw new SearchUnavailableError("Search authorization changed");
          await background.index(source, request.settings ?? [], owned);
          if (source === "settings") {
            if (settingsFingerprint(w.settings) !== fingerprint) throw new SearchUnavailableError("Settings catalogue changed; retry indexing");
            const cache = await this.store.read(w.cwd, owned, config, documents);
            total = documents.length;
            indexed = documents.filter(document => document.chunks.every(chunk => cache.vectors.has(hashText(chunk)))).length;
            if (this.current(w, epoch)) w.cache = cache;
          } else {
            const tasks = await readTaskSemanticCorpus(w.cwd, owned);
            const saved = await this.store.readTaskVectors(w.cwd, owned, config);
            total = tasks.length;
            indexed = tasks.filter(task => saved.has(task.hash)).length;
          }
        } else {
          phase = "discovery";
          const previous = w.sessionWorker;
          let previousSettled = !previous;
          const operation = (async () => {
            await bounded(owned, undefined, () => previous?.finally(() => { previousSettled = true; }) ?? Promise.resolve());
            const records = await this.discover(w, owned, true, true);
            await this.reconcileSessions(w, records, owned, false, true);
            phase = "titles";
            await this.indexSessions(w, epoch, owned, true);
            // Refresh discovery so a rename/deletion during the pass cannot be reported current.
            phase = "discovery";
            const refreshed = await this.discover(w, owned, true, true);
            await this.reconcileSessions(w, refreshed, owned, false);
            // Reuse this authenticated, refreshed snapshot instead of reading
            // the entire session corpus a third time in chunkIndexer.index().
            phase = "chunks";
            const chunks = await this.chunkIndexer(w).index(owned, true, true, refreshed);
            diagnostics = chunks.diagnostics;
            const titles = await this.store.readSessionTitles(w.cwd,owned,config);
            total = w.namedSessions.length + chunks.total + chunks.skipped;
            indexed = chunks.indexed + w.namedSessions.filter(title=>titles.get(title.sessionId)?.hash===title.hash).length;
            namedRevision = w.namedRevision;
          })();
          const worker = operation.catch(error => {
            if (this.current(w, epoch) && !owned.aborted) w.indexError = error instanceof SearchIndexBusyError || error instanceof SearchCacheCompatibilityError
              ? error.message : SESSION_PROVIDER_WARNING;
          }).finally(() => {
            if (w.sessionWorker === worker) {
              if (previous && !previousSettled) w.sessionWorker = previous;
              else delete w.sessionWorker;
            }
          });
          w.sessionWorker = worker;
          await operation;
          delete w.indexError;
        }
        phase = "finalize";
        if (!await this.consent(owned) || !this.current(w, epoch)) throw new SearchUnavailableError("Search authorization changed");
        if (source === "settings" && settingsFingerprint(w.settings) !== fingerprint) throw new SearchUnavailableError("Settings catalogue changed; retry indexing");
        if (source === "sessions" && namedRevision !== w.namedRevision) throw new SearchUnavailableError("Saved session names changed; retry indexing");
        if (sweep) await completeSessionSweep(w.cwd,sweep,owned);
        if (source === "tasks") {
          // Canonical tasks may change during the final authorization read.
          const tasks = await readTaskSemanticCorpus(w.cwd, owned);
          const saved = await this.store.readTaskVectors(w.cwd, owned, config);
          total = tasks.length; indexed = tasks.filter(task => saved.has(task.hash)).length;
        }
        if (!this.current(w, epoch)) throw new SearchUnavailableError("Search authorization changed");
        await requireSourceEnabled(w.cwd, source, owned, w.policyRevision);
        owned.throwIfAborted();
        return finish({ source, complete: indexed === total, indexed, total,
          ...(diagnostics ? { diagnostics } : {}),
          ...(indexed < total ? { message: "Indexing pass finished; continue to index remaining documents" } : {}) });
      } catch (error) {
        owned.throwIfAborted();
        return finish({ source, complete: false, message: error instanceof SearchIndexBusyError || error instanceof SearchCacheCompatibilityError
          || error instanceof SearchUnavailableError ? error.message : "Document indexing unavailable; retry this source" },
          error instanceof SearchUnavailableError && error.message === DISCOVERY_ERROR ? "discovery_failed" : "operation_failed");
      }
    });
  }
  private async discover(w: Workspace, signal: AbortSignal, strict = false, manual = false): Promise<readonly SessionMapRecord[]> {
    return bounded(signal, undefined, async owned => {
      const previous = w.refresh;
      const operation = bounded(owned, undefined, async queued => {
        await bounded(queued, undefined, () => previous.catch(() => {}));
        // The short deadline protects interactive searches. Manual Index/Continue
        // is cancellable but must be able to drain large, mature session corpora.
        try { return await bounded(queued, manual ? undefined : this.options.discoveryTimeoutMs ?? 15000,
          source => this.options.discover(w.cwd, source, strict)); }
        catch { queued.throwIfAborted(); throw new SearchUnavailableError(DISCOVERY_ERROR); }
      });
      w.refresh = operation.catch(() => {});
      return operation;
    });
  }
  private chunkIndexer(w: Workspace): DesktopSessionChunks {
    if (w.chunks) return w.chunks;
    const background = this.statusCatalog;
    return w.chunks ??= new DesktopSessionChunks(w.cwd, {
      signal: AbortSignal.any([w.controller.signal,this.network.signal]),
      discover: signal => this.discover(w,signal,true),
      discoverBackground: signal => this.options.discoverBackground?.(w.cwd,signal) ?? background.list(w.cwd,signal),
      policy: this.idlePolicy(w.cwd),
      titles: async (record, signal) => {
        const title = await hydrateBackgroundTitle(w.cwd,record,signal);
        if (!title) throw new Error("Session title could not be read");
        await this.indexSessions(w,this.epoch,signal,false,title.record,
          () => transcriptUnchanged(title.snapshot,signal));
      },
      embedding: async signal => {
        if (!await this.consent(signal) || !this.embeddingConfig) return undefined;
        const config = this.embeddingConfig, epoch = this.epoch;
        return { identity:semanticEmbeddingIdentity(config),dimension:config.dimension,
          authorized: async owned => await sourceEnabled(w.cwd,"sessions",w.policyRevision) && await this.consent(owned) && this.current(w,epoch),
          embed:(inputs,owned,beforeSend) => this.vectors(inputs,owned,"sessions",false,beforeSend) };
      },
      failed: () => { if(this.current(w)) w.indexError = "Session chunk indexing incomplete or unavailable; use Continue"; },
    });
  }
  private async vectors(inputs: readonly string[], signal: AbortSignal, domain: "settings" | "sessions" | "tasks" = "settings", query = false, beforeSend?: () => Promise<void>): Promise<number[][]> {
    const workspace = this.workspace;
    if (!workspace) throw new SearchUnavailableError("Search unavailable");
    const root = workspace.cwd;
    await requireSourceEnabled(root, domain, signal, workspace.policyRevision);
    return bounded(signal, 10000, async owned => {
      if (!await this.consent(owned)) throw new Error(PROVIDER_WARNING);
      if (!(domain === "sessions" ? this.sessionTitlesEnabled : domain === "tasks" ? this.tasksSemanticEnabled : this.enabled) || !this.keyAvailable) {
        throw new Error(domain === "sessions" ? SESSION_PROVIDER_WARNING : domain === "tasks" ? TASK_PROVIDER_WARNING : PROVIDER_WARNING);
      }
      const config = this.embeddingConfig;
      if (!config) throw new Error(PROVIDER_WARNING);
      const epoch = this.epoch;
      const key = config.provider === "ollama" ? "" : await this.auth.key(owned);
      if (!await this.consent(owned)) throw new Error(PROVIDER_WARNING);
      owned.throwIfAborted();
      if (epoch !== this.epoch || !this.embeddingConfig || semanticEmbeddingIdentity(config) !== semanticEmbeddingIdentity(this.embeddingConfig)) throw new Error(PROVIDER_WARNING);
      if (config.provider === "openrouter" && !key) throw new Error(domain === "sessions" ? SESSION_PROVIDER_WARNING : domain === "tasks" ? TASK_PROVIDER_WARNING : PROVIDER_WARNING);
      const prefix = query ? config.queryPrefix : config.documentPrefix;
      const vectors = await withProviderSlot(owned, async () => {
        await requireSourceEnabled(root, domain, owned, workspace.policyRevision);
        await beforeSend?.();
        return this.embed(inputs.map(text => (prefix + text).slice(0, 8192)), key ?? "", owned, config);
      });
      if (!await this.consent(owned)) throw new Error(PROVIDER_WARNING);
      owned.throwIfAborted();
      if (epoch !== this.epoch || !this.embeddingConfig || semanticEmbeddingIdentity(config) !== semanticEmbeddingIdentity(this.embeddingConfig)
        || vectors.length !== inputs.length || !vectors.every(vector => validVector(vector, config.dimension))) throw new Error(PROVIDER_WARNING);
      await requireSourceEnabled(root, domain, owned, workspace.policyRevision);
      return vectors;
    });
  }
  /** Reconcile only explicitly named titles, never first-message display fallbacks. */
  private async reconcileSessions(w: Workspace, records: readonly SessionMapRecord[], signal: AbortSignal, schedule = true, retry = false, strict = false): Promise<void> {
    const current = namedSessionTitles(records, w.cwd);
    const changed = current.length !== w.namedSessions.length || current.some((title, index) =>
      title.sessionId !== w.namedSessions[index]?.sessionId || title.hash !== w.namedSessions[index]?.hash);
    if (changed) {
      w.namedSessions = current;
      w.namedRevision++;
    }
    if (!this.embeddingConfig) return;
    try {
      await requireSourceEnabled(w.cwd, "sessions", signal, w.policyRevision);
      await this.store.write(w.cwd, signal, async tx => tx.sessionTitles().reconcile(current), this.embeddingConfig, { source: "sessions", retry });
      delete w.indexError;
    } catch (error) {
      signal.throwIfAborted();
      if (strict || retry) throw error;
      if (this.current(w)) {
        w.indexError = error instanceof SearchIndexBusyError || error instanceof SearchCacheCompatibilityError
          ? error.message : "Session title index unavailable; local search remains available";
      }
    }
    if (schedule) this.chunkIndexer(w).changed();
  }

  /** One SQLite-owned batch at a time, with durable hashes reused across restarts. */
  private async indexSessions(w: Workspace, epoch: number, signal: AbortSignal, retry = false, automatic?: SessionMapRecord,
    unchanged?: () => Promise<boolean>): Promise<void> {
    const config = this.embeddingConfig;
    if (!config) return;
    while (this.current(w, epoch) && this.sessionTitlesEnabled && (automatic || w.namedSessions.length)) {
      const eligible = async () => !automatic || (await this.idlePolicy(w.cwd).eligible(
        {id:automatic.piSessionId,path:automatic.piSessionPath},signal) && (!unchanged || await unchanged()));
      if (!await eligible()) throw new SessionIndexDeferred();
      let pending = false;
      await this.store.write(w.cwd, signal, async tx => {
        const revision = w.namedRevision;
        const index = tx.sessionTitles();
        if (automatic) index.reconcileOne(automatic.sessionId,namedSessionTitles([automatic],w.cwd)[0]);
        else index.reconcile(w.namedSessions);
        const missing = index.missing(16,automatic?.sessionId);
        if (!missing.length) return;
        if (!await eligible()) throw new SessionIndexDeferred();
        pending = true;
        let vectors: number[][];
        try {
          vectors = await tx.outside(() => this.vectors(missing.map(entry => entry.title), signal, "sessions", false, async () => {
            if (!await eligible()) throw new SessionIndexDeferred();
          }));
        } catch (error) {
          if (!(error instanceof SessionIndexDeferred)) throw error;
          if (automatic) throw error;
          pending = false; return;
        }
        if (!await eligible()) throw new SessionIndexDeferred();
        // Preferences can also be edited by a second Desktop process while
        // the provider is in flight. Revalidate before committing paid output.
        if (!await this.consent(signal) || !this.sessionTitlesEnabled || !this.keyAvailable || !this.current(w, epoch) || revision !== w.namedRevision) {
          throw new Error("Session title index changed during provider request");
        }
        if (!await eligible()) throw new SessionIndexDeferred();
        await requireSourceEnabled(w.cwd, "sessions", signal, w.policyRevision);
        index.save(new Map(missing.map((entry, position) => [entry.hash, vectors[position]!])));
      }, config, { source: "sessions", retry });
      retry = false;
      if (!pending) break;
    }
    if (automatic && (!this.current(w, epoch) || !this.sessionTitlesEnabled)) throw new SessionIndexDeferred();
  }
  /** Rank already indexed canonical hashes; a query never creates missing task vectors. */
  async queryTasks(request: SemanticTasksRequest, caller = new AbortController().signal): Promise<SemanticTasksResponse> {
    caller.throwIfAborted();
    const w = await this.activate(request.cwd);
    if (!w.enabled.tasks) return { results: [], pendingIndex: false };
    const signal = AbortSignal.any([caller, w.controller.signal]);
    if (!await this.consent(signal) || !this.tasksSemanticEnabled || !this.keyAvailable) return { results: [], pendingIndex: false };
    const config = this.embeddingConfig!;
    const epoch = this.epoch;
    const owned = AbortSignal.any([signal, this.network.signal]);
    const documents = await readTaskSemanticCorpus(w.cwd, owned);
    if (!this.current(w, epoch) || !documents.length) return { results: [], pendingIndex: false };
    // Avoid embedding a query when no task document has a usable vector yet.
    const saved = await this.store.readTaskVectors(w.cwd, owned, config);
    const pendingIndex = documents.some(task => !saved.has(task.hash));
    if (!documents.some(task => saved.has(task.hash))) return { results: [], pendingIndex };
    const queryVector = (await this.vectors([request.query], owned, "tasks", true))[0]!;
    if (!await this.consent(owned) || !this.current(w, epoch) || !this.tasksSemanticEnabled || !this.keyAvailable) return { results: [], pendingIndex: false };
    // A task may have changed while its query vector was being calculated.
    const currentDocuments = await readTaskSemanticCorpus(w.cwd, owned);
    if (!await this.consent(owned)) return { results: [], pendingIndex: false };
    owned.throwIfAborted();
    if (!this.current(w, epoch)) return { results: [], pendingIndex: false };
    const results: SemanticTaskHit[] = [];
    for (const task of currentDocuments) {
      const vector = saved.get(task.hash);
      if (!vector) continue;
      const similarity = cosine(queryVector, vector);
      if (similarity < 0.25) continue;
      results.push({ kind: "tasks", id: `tasks:${task.id}`, taskId: task.id, title: task.title,
        snippet: task.snippet, score: similarity, semantic: true });
    }
    results.sort((a, b) => b.score - a.score || a.taskId.localeCompare(b.taskId));
    await requireSourceEnabled(w.cwd, "tasks", owned, w.policyRevision);
    return { results: results.slice(0, request.limit), pendingIndex: currentDocuments.some(task => !saved.has(task.hash)) };
  }
  async query(request: SearchQueryRequest, caller = new AbortController().signal): Promise<SearchQueryResponse> {
    caller.throwIfAborted();
    const w = await this.activate(request.cwd);
    const wantsSettings = w.enabled.settings && request.types.includes("settings");
    const catalogueRevision = wantsSettings ? ++this.catalogueRevision : undefined;
    const signal = AbortSignal.any([caller, w.controller.signal]);
    let authorized = await this.consent(signal);
    signal.throwIfAborted();
    if (!this.current(w)) throw new SearchUnavailableError("Search unavailable");
    if (catalogueRevision !== undefined && catalogueRevision !== this.catalogueRevision) return { results: [], status: this.status() };
    const epoch = this.epoch;
    const settings = wantsSettings ? settingsDocuments(request.settings) : [];
    if (wantsSettings) { w.settings = settings; w.catalogue = [...request.settings]; this.background(w)?.catalogue(request.settings); }
    const wantsSessions = w.enabled.sessions && request.types.includes("sessions");
    const indexedRecords = async () => {
      try {
        return await bounded(signal, this.options.discoveryTimeoutMs ?? 15000, async owned =>
          indexedSessionRecords(w.cwd, owned, await this.options.sessionRecords?.(w.cwd, owned)));
      } catch {
        signal.throwIfAborted();
        throw new SearchUnavailableError("Session index metadata unavailable or timed out");
      }
    };
    let records = wantsSessions ? await indexedRecords() : [];
    if (wantsSessions) {
      await this.reconcileSessions(w, records, signal, false);
    }
    authorized = await this.consent(signal);
    let queryVector: number[] | undefined;
    const query = request.query.trim();
    const semanticSettings = authorized && wantsSettings && w.settings.length > 0 && this.enabled;
    const semanticSessions = authorized && wantsSessions && this.sessionTitlesEnabled && (w.namedSessions.length > 0
      || (this.embeddingConfig && await hasSessionChunkVectors(w.cwd,transcriptCandidates(records),signal,
        {identity:semanticEmbeddingIdentity(this.embeddingConfig),dimension:this.embeddingConfig.dimension}).catch(()=>{signal.throwIfAborted();return false;})));
    if (query && (semanticSettings || semanticSessions) && this.keyAvailable && this.current(w, epoch)) {
      const owned = AbortSignal.any([signal, this.network.signal]);
      try {
        queryVector = w.queryVectors.get(query);
        if (!queryVector) {
          queryVector = (await this.vectors([query], owned, semanticSettings ? "settings" : "sessions", true))[0]!;
          if (this.current(w, epoch)) {
            if (w.queryVectors.size >= 100) w.queryVectors.delete(w.queryVectors.keys().next().value!);
            w.queryVectors.set(query, queryVector);
          }
        }
        if (this.current(w, epoch) && semanticSettings) {
          try {
            const cache = await this.store.read(w.cwd, owned, this.embeddingConfig, w.settings);
            if (this.current(w, epoch)) w.cache = cache;
          } catch {
            owned.throwIfAborted();
            if (this.current(w, epoch)) {
              w.cache = emptyIndex();
              w.indexError = "Settings index unavailable; other sources remain available";
            }
          }
        }
      } catch {
        signal.throwIfAborted();
        queryVector = undefined;
        if (this.current(w, epoch)) w.error = semanticSettings ? PROVIDER_WARNING : SESSION_PROVIDER_WARNING;
      }
      // Provider failure/revocation can still outlive a title rename or deletion.
      if (wantsSessions) {
        records = await indexedRecords();
        await this.reconcileSessions(w, records, signal);
      }
    }
    signal.throwIfAborted();
    if (!this.current(w)) throw new SearchUnavailableError("Search unavailable");
    if (!this.current(w, epoch)) queryVector = undefined;
    const results: LocalSearchHit[] = wantsSessions ? sessionTitleHits(records, w.cwd, query) : [];
    if (!await this.consent(signal) || !this.current(w, epoch)) queryVector = undefined;
    if (wantsSessions && queryVector && this.sessionTitlesEnabled) {
      try {
        const embeddings = await this.store.readSessionTitles(w.cwd, signal, this.embeddingConfig);
        if (!await this.consent(signal) || !this.current(w, epoch)) queryVector = undefined;
        for (const title of namedSessionTitles(records, w.cwd)) {
          if (!queryVector) break;
          const stored = embeddings.get(title.sessionId);
          if (!stored || stored.hash !== title.hash) continue;
          const similarity = cosine(queryVector, stored.vector);
          if (similarity < 0.25) continue;
          const position = results.findIndex(hit => hit.kind === "sessions" && hit.sessionId === title.sessionId);
          if (position >= 0) {
            const existing = results[position]! as SessionSearchHit;
            results[position] = { ...existing, score: Math.max(existing.score, similarity), semantic: true };
          }
          else {
            const hit: SessionSearchHit = { kind: "sessions", id: `sessions:${title.sessionId}`,
              sessionId: title.sessionId, title: title.title, snippet: "", score: similarity, semantic: true };
            results.push(hit);
          }
        }
      } catch {
        signal.throwIfAborted();
        if (this.current(w, epoch)) w.indexError = "Session title index unavailable; local search remains available";
      }
    }
    if (wantsSessions && query) {
      try {
        const chunks = await sessionChunkHits(w.cwd,records,query,signal,this.embeddingConfig,queryVector);
        if (!await this.consent(signal) || !this.current(w,epoch)) {
          chunks.splice(0,chunks.length,...await sessionChunkHits(w.cwd,records,query,signal));
        }
        for (const hit of chunks) {
          const position = results.findIndex(item => item.id === hit.id);
          if(position < 0) results.push(hit);
          else results[position] = {...hit,score:Math.max(hit.score,results[position]!.score)};
        }
      } catch { signal.throwIfAborted(); if(this.current(w)) w.indexError = "Session chunk search unavailable"; }
    }
    if (wantsSettings && query) for (const document of settings) {
      let score = lexicalScore(document.text, query);
      if (queryVector) for (const text of document.chunks) {
        const vector = w.cache.vectors.get(hashText(text));
        if (vector) { const similarity = cosine(queryVector, vector); if (similarity >= 0.25) score = Math.max(score, similarity); }
      }
      if (score > 0) results.push({ ...document.hit, score });
    }
    results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    if (wantsSettings) await requireSourceEnabled(w.cwd, "settings", signal, w.policyRevision);
    if (wantsSessions) await requireSourceEnabled(w.cwd, "sessions", signal, w.policyRevision);
    const fresh = wantsSessions ? new Map((await indexedRecords()).map(r => [r.sessionId,r.indexRevision])) : new Map();
    const captured = new Map(records.map(r => [r.sessionId,r.indexRevision]));
    return { results: results.filter(hit => hit.kind !== "sessions" || fresh.get(hit.sessionId) === captured.get(hit.sessionId))
      .slice(0, request.limit), status: this.status() };
  }
  changed(cwd: string): void {
    // Queries validate indexed file stamps; background indexing owns JSONL reads.
    if (this.workspace?.cwd === resolve(cwd)) {
      this.workspace.queryVectors.clear();
      this.workspace.namedRevision++;
      // A rename/delete invalidates the captured title set. An in-flight
      // provider must not retry embedding an old title before rediscovery.
      this.workspace.namedSessions = [];
      const w = this.workspace;
      if (w.enabled.sessions) void sourceEnabled(w.cwd, "sessions").then(enabled => {
        if (enabled && this.current(w)) this.chunkIndexer(w).changed();
      });
    }
  }
  async dispose(): Promise<void> {
    this.statusCatalog.dispose();
    this.disposed = true; this.workspace?.unwatchPolicy(); this.workspace?.controller.abort(); this.revoke();
    await this.workspace?.background?.dispose();
    await this.workspace?.chunks?.dispose();
    await Promise.allSettled([...this.activity.values()].map(policy=>policy.dispose()));
    this.activity.clear();
    await Promise.allSettled([...this.retired]);
    await this.workspace?.sessionWorker;
    await this.workspace?.refresh.catch(() => {});
    await this.configQueue.catch(() => {});
    await this.indexActions.settled();
    this.workspace = undefined;
  }
}
