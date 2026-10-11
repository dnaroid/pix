import { resolve } from "node:path";
import type { SessionMapRecord } from "../acp/session-map.js";
import type { LocalSearchHit, SearchConfigRequest, SearchIndexRequest, SearchIndexResponse, SearchSyncRequest, SearchQueryRequest, SearchQueryResponse, SearchStatus, SessionSearchHit, SemanticTasksRequest, SemanticTasksResponse, SemanticTaskHit } from "./contract.js";
import { SearchPreferences, sharedSearchAuth, semanticEmbeddingIdentity, type SemanticEmbeddingConfig, type SearchAuth } from "./config.js";
import { parseSearchConfigRequest, parseSearchIndexRequest, parseSearchSyncRequest } from "./request.js";
import { bounded } from "./bounded.js";
import { hashText, lexicalScore, settingsDocuments, settingsFingerprint, type SearchDocument } from "./documents.js";
import { cosine, embedOpenRouter, validVector, type Embedder } from "./embeddings.js";
import { SearchIndexBusyError, SearchIndexStore, emptyIndex, type CachedIndex } from "./index-store.js";
import { sessionTitleHits } from "./session-titles.js";
import { namedSessionTitles, type NamedSessionTitle } from "./session-index.js";
import { synchronizeSessionBoundaries } from "./session-boundary-service.js";
import { readTaskSemanticCorpus } from "./task-corpus.js";
import { SettingsTaskIndexer } from "./settings-task-indexer.js";
import type { TaskChangeWatcher } from "./task-watcher.js";
import { SearchCacheCompatibilityError } from "./embedding-cache.js";
import { IndexActions } from "./index-actions.js";

const PROVIDER_WARNING = "Semantic settings search unavailable; local search remains available";
const SESSION_PROVIDER_WARNING = "Semantic session-title search unavailable; local search remains available";
const TASK_PROVIDER_WARNING = "Semantic task search unavailable; local task search remains available";
const DISCOVERY_ERROR = "Session title discovery timed out or failed";
export class SearchUnavailableError extends Error {}
interface Workspace {
  cwd: string;
  controller: AbortController;
  cache: CachedIndex;
  settings: SearchDocument[];
  namedSessions: NamedSessionTitle[];
  namedRevision: number;
  refresh: Promise<unknown>;
  background?: SettingsTaskIndexer;
  sessionWorker?: Promise<void>;
  queryVectors: Map<string, number[]>;
  migrated: boolean;
  migration?: Promise<void>;
  indexError?: string;
  error?: string;
}
export interface SearchServiceOptions {
  discover(cwd: string, signal: AbortSignal): Promise<readonly SessionMapRecord[]>;
  preferences?: SearchPreferences;
  auth?: SearchAuth;
  discoveryTimeoutMs?: number;
  store?: SearchIndexStore;
  embed?: Embedder;
  watchTasks?: TaskChangeWatcher;
  taskDebounceMs?: number;
}
/** Only explicit session names may be persisted/embedded; history stays local. */
export class DesktopSearchService {
  private readonly preferences: SearchPreferences;
  private readonly auth: SearchAuth;
  private readonly store: SearchIndexStore;
  private readonly embed: Embedder;
  private workspace: Workspace | undefined;
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
    }
  }
  private current(w: Workspace, epoch = this.epoch): boolean {
    return !this.disposed && this.workspace === w && !w.controller.signal.aborted && this.epoch === epoch;
  }
  private status(): SearchStatus {
    const sources = { settings: this.workspace?.background?.indexing.settings ?? false,
      tasks: this.workspace?.background?.indexing.tasks ?? false, sessions: Boolean(this.workspace?.sessionWorker) };
    const sourceErrors = { ...this.workspace?.background?.errors,
      ...(this.workspace?.indexError ? { sessions: this.workspace.indexError } : {}) };
    const error = this.workspace?.indexError ?? sourceErrors.settings ?? sourceErrors.tasks ?? this.workspace?.error;
    return { enabled: this.enabled, sessionTitlesEnabled: this.sessionTitlesEnabled, tasksSemanticEnabled: this.tasksSemanticEnabled,
      keyAvailable: this.keyAvailable, indexing: Object.values(sources).some(Boolean), indexingSources: sources,
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
  private async activate(cwd: string, migrate = true): Promise<Workspace> {
    if (this.disposed) throw new SearchUnavailableError("Search unavailable");
    const path = resolve(cwd);
    if (this.workspace?.cwd === path) {
      const w = this.workspace;
      if (migrate) await this.migrate(w);
      w.controller.signal.throwIfAborted();
      return w;
    }
    this.workspace?.controller.abort(); this.revoke();
    const w: Workspace = { cwd: path, controller: new AbortController(), cache: emptyIndex(), settings: [],
      namedSessions: [], namedRevision: 0, refresh: Promise.resolve(), queryVectors: new Map(), migrated: false };
    this.workspace = w;
    if (migrate) await this.migrate(w);
    w.controller.signal.throwIfAborted();
    return w;
  }
  private async migrate(w: Workspace): Promise<void> {
    if (w.migrated) return;
    if (!w.migration) {
      // Retry transient contention on later sync/query activation, not status polling.
      const operation = this.store.write(w.cwd, w.controller.signal, async tx => { w.cache = await tx.load(); })
        .then(() => { w.migrated = true; delete w.indexError; })
        .catch(error => {
          w.controller.signal.throwIfAborted();
          w.indexError = error instanceof SearchIndexBusyError ? error.message : "Search index unavailable; local search remains available";
        }).finally(() => { if (w.migration === operation) delete w.migration; });
      w.migration = operation;
    }
    await w.migration;
  }
  async config(request: SearchConfigRequest, signal = new AbortController().signal): Promise<SearchStatus> {
    request = parseSearchConfigRequest(request);
    const operation = this.configQueue.catch(() => {}).then(async () => {
      if (this.disposed) return;
      const w = await this.activate(request.cwd, false);
      const owned = AbortSignal.any([signal, w.controller.signal]);
      try {
        owned.throwIfAborted();
        await this.consent(owned);
      } catch {
        owned.throwIfAborted();
        throw new SearchUnavailableError("Search configuration unavailable");
      }
      // Reading status/config never starts provider work.
    });
    this.configQueue = operation;
    await operation;
    signal.throwIfAborted();
    return this.status();
  }
  private background(w: Workspace): SettingsTaskIndexer | undefined {
    if (!this.current(w) || !this.embeddingConfig || !this.enabled || !this.keyAvailable) return undefined;
    return w.background ??= new SettingsTaskIndexer({ cwd: w.cwd,
      signal: AbortSignal.any([w.controller.signal, this.network.signal]), config: this.embeddingConfig,
      store: this.store, embed: (inputs, signal, domain) => this.vectors(inputs, signal, domain),
      authorized: signal => this.consent(signal), watchTasks: this.options.watchTasks, debounceMs: this.options.taskDebounceMs,
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
    const w = await this.activate(request.cwd, false);
    const key = JSON.stringify([w.cwd, request.source, fingerprint]);
    // Coalesce before consent as well: two first-use clicks must not supersede
    // one another's authorization reads and return a fictitious missing config.
    return this.indexActions.run(key, caller, w.controller.signal, async operationSignal => {
      const source = request.source;
      if (!await bounded(operationSignal, undefined, signal => this.consent(signal))) return { source, complete: false,
        message: "Configure an embedding model and its credential to index this source" };
      const owned = AbortSignal.any([operationSignal, this.network.signal]);
      owned.throwIfAborted();
      const config = this.embeddingConfig!;
      const epoch = this.epoch;
      try {
        let indexed = 0, total = 0;
        let namedRevision: number | undefined;
        if (source === "settings" || source === "tasks") {
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
            const cache = await this.store.read(w.cwd, owned, config);
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
          const previous = w.sessionWorker;
          let previousSettled = !previous;
          const operation = (async () => {
            await bounded(owned, undefined, () => previous?.finally(() => { previousSettled = true; }) ?? Promise.resolve());
            const records = await this.discover(w, owned);
            await this.reconcileSessions(w, records, owned, false);
            await this.indexSessions(w, epoch, owned, 8);
            // Refresh discovery so a rename/deletion during the pass cannot be reported current.
            await this.reconcileSessions(w, await this.discover(w, owned), owned, false);
            const saved = await this.store.readSessionTitles(w.cwd, owned, config);
            total = w.namedSessions.length;
            indexed = w.namedSessions.filter(title => saved.get(title.sessionId)?.hash === title.hash).length;
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
        if (!await this.consent(owned) || !this.current(w, epoch)) throw new SearchUnavailableError("Search authorization changed");
        if (source === "settings" && settingsFingerprint(w.settings) !== fingerprint) throw new SearchUnavailableError("Settings catalogue changed; retry indexing");
        if (source === "sessions" && namedRevision !== w.namedRevision) throw new SearchUnavailableError("Saved session names changed; retry indexing");
        if (source === "tasks") {
          // Canonical tasks may change during the final authorization read.
          const tasks = await readTaskSemanticCorpus(w.cwd, owned);
          const saved = await this.store.readTaskVectors(w.cwd, owned, config);
          total = tasks.length; indexed = tasks.filter(task => saved.has(task.hash)).length;
        }
        if (!this.current(w, epoch)) throw new SearchUnavailableError("Search authorization changed");
        owned.throwIfAborted();
        return { source, complete: indexed === total, indexed, total,
          ...(indexed < total ? { message: "Indexing pass finished; continue to index remaining documents" } : {}) };
      } catch (error) {
        owned.throwIfAborted();
        return { source, complete: false, message: error instanceof SearchIndexBusyError || error instanceof SearchCacheCompatibilityError
          || error instanceof SearchUnavailableError ? error.message : "Document indexing unavailable; retry this source" };
      }
    });
  }
  private async discover(w: Workspace, signal: AbortSignal): Promise<readonly SessionMapRecord[]> {
    return bounded(signal, undefined, async owned => {
      const previous = w.refresh;
      const operation = bounded(owned, undefined, async queued => {
        await bounded(queued, undefined, () => previous.catch(() => {}));
        try { return await bounded(queued, this.options.discoveryTimeoutMs ?? 15000, source => this.options.discover(w.cwd, source)); }
        catch { queued.throwIfAborted(); throw new SearchUnavailableError(DISCOVERY_ERROR); }
      });
      w.refresh = operation.catch(() => {});
      return operation;
    });
  }
  private async vectors(inputs: readonly string[], signal: AbortSignal, domain: "settings" | "sessions" | "tasks" = "settings", query = false): Promise<number[][]> {
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
      const vectors = await this.embed(inputs.map(text => (prefix + text).slice(0, 8192)), key ?? "", owned, config);
      if (!await this.consent(owned)) throw new Error(PROVIDER_WARNING);
      owned.throwIfAborted();
      if (epoch !== this.epoch || !this.embeddingConfig || semanticEmbeddingIdentity(config) !== semanticEmbeddingIdentity(this.embeddingConfig)
        || vectors.length !== inputs.length || !vectors.every(vector => validVector(vector, config.dimension))) throw new Error(PROVIDER_WARNING);
      return vectors;
    });
  }
  /** Reconcile only explicitly named titles, never first-message display fallbacks. */
  private async reconcileSessions(w: Workspace, records: readonly SessionMapRecord[], signal: AbortSignal, schedule = true): Promise<void> {
    const current = namedSessionTitles(records, w.cwd);
    const changed = current.length !== w.namedSessions.length || current.some((title, index) =>
      title.sessionId !== w.namedSessions[index]?.sessionId || title.hash !== w.namedSessions[index]?.hash);
    if (changed) {
      w.namedSessions = current;
      w.namedRevision++;
    }
    if (!this.embeddingConfig) return;
    try {
      await this.store.write(w.cwd, signal, async tx => tx.sessionTitles().reconcile(current), this.embeddingConfig);
      delete w.indexError;
    } catch (error) {
      signal.throwIfAborted();
      if (!schedule) throw error;
      if (this.current(w)) {
        w.indexError = error instanceof SearchIndexBusyError || error instanceof SearchCacheCompatibilityError
          ? error.message : "Session title index unavailable; local search remains available";
      }
    }
    if (schedule) this.scheduleSessions(w);
  }

  private async refreshSessionBoundaries(w: Workspace, records: readonly SessionMapRecord[], signal: AbortSignal): Promise<void> {
    try {
      await synchronizeSessionBoundaries(this.store, w.cwd, records, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (this.current(w)) w.indexError = error instanceof SearchIndexBusyError
        ? error.message : "Local session excerpt index unavailable; title search remains available";
    }
  }

  private scheduleSessions(w: Workspace): void {
    if (w.sessionWorker || !this.current(w) || !this.sessionTitlesEnabled || !this.keyAvailable || !w.namedSessions.length) return;
    const epoch = this.epoch;
    const revision = w.namedRevision;
    const signal = AbortSignal.any([w.controller.signal, this.network.signal]);
    const worker = this.indexSessions(w, epoch, signal).catch(error => {
      if (this.current(w, epoch) && !signal.aborted) {
        w.indexError = error instanceof SearchIndexBusyError || error instanceof SearchCacheCompatibilityError ? error.message : SESSION_PROVIDER_WARNING;
      }
    }).finally(() => {
      if (w.sessionWorker === worker) delete w.sessionWorker;
      if (this.current(w) && (epoch !== this.epoch || revision !== w.namedRevision)) this.scheduleSessions(w);
    });
    w.sessionWorker = worker;
  }

  /** One SQLite-owned batch at a time, with durable hashes reused across restarts. */
  private async indexSessions(w: Workspace, epoch: number, signal: AbortSignal, batches = Infinity): Promise<void> {
    const config = this.embeddingConfig;
    if (!config) return;
    while (this.current(w, epoch) && this.sessionTitlesEnabled && w.namedSessions.length && batches-- > 0) {
      let pending = false;
      await this.store.write(w.cwd, signal, async tx => {
        const revision = w.namedRevision;
        const index = tx.sessionTitles();
        index.reconcile(w.namedSessions);
        const missing = index.missing(16);
        if (!missing.length) return;
        pending = true;
        const vectors = await this.vectors(missing.map(entry => entry.title), signal, "sessions");
        // Preferences can also be edited by a second Desktop process while
        // the provider is in flight. Revalidate before committing paid output.
        if (!await this.consent(signal) || !this.sessionTitlesEnabled || !this.keyAvailable || !this.current(w, epoch) || revision !== w.namedRevision) {
          throw new Error("Session title index changed during provider request");
        }
        index.save(new Map(missing.map((entry, position) => [entry.hash, vectors[position]!])));
      }, config);
      if (!pending) break;
    }
  }
  /** Rank already indexed canonical hashes; a query never creates missing task vectors. */
  async queryTasks(request: SemanticTasksRequest, caller = new AbortController().signal): Promise<SemanticTasksResponse> {
    caller.throwIfAborted();
    const w = await this.activate(request.cwd);
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
    return { results: results.slice(0, request.limit), pendingIndex: currentDocuments.some(task => !saved.has(task.hash)) };
  }
  async query(request: SearchQueryRequest, caller = new AbortController().signal): Promise<SearchQueryResponse> {
    caller.throwIfAborted();
    const wantsSettings = request.types.includes("settings");
    const catalogueRevision = wantsSettings ? ++this.catalogueRevision : undefined;
    const w = await this.activate(request.cwd);
    const signal = AbortSignal.any([caller, w.controller.signal]);
    let authorized = await this.consent(signal);
    signal.throwIfAborted();
    if (!this.current(w)) throw new SearchUnavailableError("Search unavailable");
    if (catalogueRevision !== undefined && catalogueRevision !== this.catalogueRevision) return { results: [], status: this.status() };
    const epoch = this.epoch;
    const settings = wantsSettings ? settingsDocuments(request.settings) : [];
    if (wantsSettings) { w.settings = settings; this.background(w)?.catalogue(request.settings); }
    const wantsSessions = request.types.includes("sessions");
    let records = wantsSessions ? await this.discover(w, signal) : [];
    if (wantsSessions) {
      await this.reconcileSessions(w, records, signal);
      await this.refreshSessionBoundaries(w, records, signal);
    }
    authorized = await this.consent(signal);
    let queryVector: number[] | undefined;
    const query = request.query.trim();
    const semanticSettings = authorized && wantsSettings && w.settings.length > 0 && this.enabled;
    const semanticSessions = authorized && wantsSessions && w.namedSessions.length > 0 && this.sessionTitlesEnabled;
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
          const cache = await this.store.read(w.cwd, owned, this.embeddingConfig);
          if (this.current(w, epoch)) w.cache = cache;
        }
      } catch {
        signal.throwIfAborted();
        queryVector = undefined;
        if (this.current(w, epoch)) w.error = semanticSettings ? PROVIDER_WARNING : SESSION_PROVIDER_WARNING;
      }
      // Provider failure/revocation can still outlive a title rename or deletion.
      if (wantsSessions) {
        records = await this.discover(w, signal);
        await this.reconcileSessions(w, records, signal);
        await this.refreshSessionBoundaries(w, records, signal);
      }
    }
    signal.throwIfAborted();
    if (!this.current(w)) throw new SearchUnavailableError("Search unavailable");
    if (!this.current(w, epoch)) queryVector = undefined;
    const results: LocalSearchHit[] = wantsSessions ? sessionTitleHits(records, w.cwd, query) : [];
    if (wantsSessions && query) {
      try {
        const byId = new Map(records.filter(record => resolve(record.cwd) === w.cwd && record.title?.trim())
          .map(record => [record.sessionId, record.title!.trim()]));
        for (const hit of await this.store.searchSessionBoundaries(w.cwd, query, signal)) {
          const title = byId.get(hit.sessionId);
          if (!title) continue;
          const position = results.findIndex(candidate => candidate.kind === "sessions" && candidate.sessionId === hit.sessionId);
          if (position >= 0 && results[position]?.kind === "sessions") {
            results[position] = { ...results[position] as SessionSearchHit, snippet: hit.snippet, boundaryMatch: true };
          } else {
            results.push({ ...hit, title });
          }
        }
      } catch {
        signal.throwIfAborted();
        if (this.current(w)) w.indexError = "Local session excerpt search unavailable; title search remains available";
      }
    }
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
    if (wantsSettings && query) for (const document of settings) {
      let score = lexicalScore(document.text, query);
      if (queryVector) for (const text of document.chunks) {
        const vector = w.cache.vectors.get(hashText(text));
        if (vector) { const similarity = cosine(queryVector, vector); if (similarity >= 0.25) score = Math.max(score, similarity); }
      }
      if (score > 0) results.push({ ...document.hit, score });
    }
    results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return { results: results.slice(0, request.limit), status: this.status() };
  }
  changed(cwd: string): void {
    // Discovery on every explicit query observes renames/deletions; there is no history scanner.
    if (this.workspace?.cwd === resolve(cwd)) {
      this.workspace.queryVectors.clear();
      this.workspace.namedRevision++;
      // A rename/delete invalidates the captured title set. An in-flight
      // provider must not retry embedding an old title before rediscovery.
      this.workspace.namedSessions = [];
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true; this.workspace?.controller.abort(); this.revoke();
    await this.workspace?.background?.dispose();
    await Promise.allSettled([...this.retired]);
    await this.workspace?.sessionWorker;
    await this.workspace?.migration?.catch(() => {});
    await this.workspace?.refresh.catch(() => {});
    await this.configQueue.catch(() => {});
    await this.indexActions.settled();
    this.workspace = undefined;
  }
}
