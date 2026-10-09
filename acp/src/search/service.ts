import { resolve } from "node:path";
import type { SessionMapRecord } from "../acp/session-map.js";
import type { LocalSearchHit, SearchConfigRequest, SearchQueryRequest, SearchQueryResponse, SearchStatus, SessionSearchHit } from "./contract.js";
import { SearchPreferences, sharedSearchAuth, type SearchAuth } from "./config.js";
import { bounded } from "./bounded.js";
import { hashText, lexicalScore, settingsDocuments, type SearchDocument } from "./documents.js";
import { cosine, embedOpenRouter, validVector, type Embedder } from "./embeddings.js";
import { SearchIndexBusyError, SearchIndexStore, emptyIndex, type CachedIndex } from "./index-store.js";
import { sessionTitleHits } from "./session-titles.js";
import { namedSessionTitles, type NamedSessionTitle } from "./session-index.js";
import { synchronizeSessionBoundaries } from "./session-boundary-service.js";

const PROVIDER_WARNING = "Semantic settings search unavailable; local search remains available";
const SESSION_PROVIDER_WARNING = "Semantic session-title search unavailable; local search remains available";
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
  worker?: Promise<void>;
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
  private keyAvailable = false;
  private disposed = false;
  private configQueue: Promise<void> = Promise.resolve();
  constructor(private readonly options: SearchServiceOptions) {
    this.preferences = options.preferences ?? new SearchPreferences();
    this.auth = options.auth ?? sharedSearchAuth();
    this.store = options.store ?? new SearchIndexStore();
    this.embed = options.embed ?? embedOpenRouter;
  }
  private revoke(): void { this.epoch++; this.network.abort(); this.network = new AbortController(); }
  private current(w: Workspace, epoch = this.epoch): boolean {
    return !this.disposed && this.workspace === w && !w.controller.signal.aborted && this.epoch === epoch;
  }
  private status(): SearchStatus {
    return { enabled: this.enabled, sessionTitlesEnabled: this.sessionTitlesEnabled,
      keyAvailable: this.keyAvailable, indexing: Boolean(this.workspace?.worker || this.workspace?.sessionWorker),
      ...((this.workspace?.indexError ?? this.workspace?.error) ? { error: this.workspace?.indexError ?? this.workspace?.error } : {}) };
  }
  private async consent(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    let enabled = false;
    let sessionTitlesEnabled = false;
    try {
      enabled = await this.preferences.enabled();
      sessionTitlesEnabled = await this.preferences.sessionTitlesEnabled();
    }
    catch { if (this.workspace) this.workspace.error = "Search preferences unavailable; local search remains available"; }
    signal.throwIfAborted();
    if (enabled !== this.enabled || sessionTitlesEnabled !== this.sessionTitlesEnabled) {
      this.revoke();
      this.enabled = enabled;
      this.sessionTitlesEnabled = sessionTitlesEnabled;
    }
    const hadKey = this.keyAvailable;
    try { this.keyAvailable = await this.auth.available(signal); }
    catch { this.keyAvailable = false; if (this.workspace) this.workspace.error = "Search credentials unavailable; local search remains available"; }
    signal.throwIfAborted();
    if (hadKey && !this.keyAvailable) this.revoke();
    return (this.enabled || this.sessionTitlesEnabled) && this.keyAvailable && !this.disposed;
  }
  private async activate(cwd: string): Promise<Workspace> {
    if (this.disposed) throw new SearchUnavailableError("Search unavailable");
    const path = resolve(cwd);
    if (this.workspace?.cwd === path) {
      const w = this.workspace;
      await this.migrate(w);
      w.controller.signal.throwIfAborted();
      return w;
    }
    this.workspace?.controller.abort(); this.revoke();
    const w: Workspace = { cwd: path, controller: new AbortController(), cache: emptyIndex(), settings: [],
      namedSessions: [], namedRevision: 0, refresh: Promise.resolve(), queryVectors: new Map(), migrated: false };
    this.workspace = w;
    await this.migrate(w);
    w.controller.signal.throwIfAborted();
    return w;
  }
  private async migrate(w: Workspace): Promise<void> {
    if (w.migrated) return;
    if (!w.migration) {
      // Retry transient contention on later activation/status requests, without provider work.
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
    const changed = request.enabled !== undefined || request.sessionTitlesEnabled !== undefined || request.apiKey !== undefined;
    if (changed) this.revoke();
    if (request.enabled === false) this.enabled = false;
    if (request.sessionTitlesEnabled === false) this.sessionTitlesEnabled = false;
    const operation = this.configQueue.catch(() => {}).then(async () => {
      if (this.disposed) return;
      const w = await this.activate(request.cwd);
      const owned = AbortSignal.any([signal, w.controller.signal]);
      try {
        owned.throwIfAborted();
        if (request.apiKey !== undefined) await this.auth.save(request.apiKey, owned);
        if (request.enabled !== undefined) await this.preferences.setEnabled(request.enabled);
        if (request.sessionTitlesEnabled !== undefined) await this.preferences.setSessionTitlesEnabled(request.sessionTitlesEnabled);
        if (changed) delete w.error;
        await this.consent(owned);
      } catch {
        owned.throwIfAborted();
        throw new SearchUnavailableError("Search configuration could not be updated");
      }
      // Merely enabling session-title consent must not upload an earlier,
      // potentially stale title snapshot. Only a fresh explicit session search
      // may start session-vector indexing after native title rediscovery.
      if (changed) this.schedule(w);
    });
    this.configQueue = operation;
    await operation;
    signal.throwIfAborted();
    return this.status();
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
  private async vectors(inputs: readonly string[], signal: AbortSignal, domain: "settings" | "sessions" = "settings"): Promise<number[][]> {
    return bounded(signal, 10000, async owned => {
      await this.consent(owned);
      if (!(domain === "sessions" ? this.sessionTitlesEnabled : this.enabled) || !this.keyAvailable) {
        throw new Error(domain === "sessions" ? SESSION_PROVIDER_WARNING : PROVIDER_WARNING);
      }
      const key = await this.auth.key(owned);
      owned.throwIfAborted();
      if (!key) throw new Error(domain === "sessions" ? SESSION_PROVIDER_WARNING : PROVIDER_WARNING);
      const vectors = await this.embed(inputs, key, owned);
      owned.throwIfAborted();
      if (vectors.length !== inputs.length || !vectors.every(validVector)) throw new Error(PROVIDER_WARNING);
      return vectors;
    });
  }
  /** Reconcile only explicitly named titles, never first-message display fallbacks. */
  private async reconcileSessions(w: Workspace, records: readonly SessionMapRecord[], signal: AbortSignal): Promise<void> {
    const current = namedSessionTitles(records, w.cwd);
    const changed = current.length !== w.namedSessions.length || current.some((title, index) =>
      title.sessionId !== w.namedSessions[index]?.sessionId || title.hash !== w.namedSessions[index]?.hash);
    if (changed) {
      w.namedSessions = current;
      w.namedRevision++;
    }
    try {
      await this.store.write(w.cwd, signal, async tx => tx.sessionTitles().reconcile(current));
      delete w.indexError;
    } catch (error) {
      signal.throwIfAborted();
      if (this.current(w)) {
        w.indexError = error instanceof SearchIndexBusyError
          ? error.message : "Session title index unavailable; local search remains available";
      }
    }
    this.scheduleSessions(w);
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
        w.indexError = error instanceof SearchIndexBusyError ? error.message : SESSION_PROVIDER_WARNING;
      }
    }).finally(() => {
      if (w.sessionWorker === worker) delete w.sessionWorker;
      if (this.current(w) && (epoch !== this.epoch || revision !== w.namedRevision)) this.scheduleSessions(w);
    });
    w.sessionWorker = worker;
  }

  /** One SQLite-owned batch at a time, with durable hashes reused across restarts. */
  private async indexSessions(w: Workspace, epoch: number, signal: AbortSignal): Promise<void> {
    while (this.current(w, epoch) && this.sessionTitlesEnabled && w.namedSessions.length) {
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
        await this.consent(signal);
        if (!this.sessionTitlesEnabled || !this.keyAvailable || !this.current(w, epoch) || revision !== w.namedRevision) {
          throw new Error("Session title index changed during provider request");
        }
        index.save(new Map(missing.map((entry, position) => [entry.hash, vectors[position]!])));
      });
      if (!pending) break;
    }
  }
  private schedule(w: Workspace): void {
    if (w.worker || !this.current(w) || !w.settings.length) return;
    const epoch = this.epoch;
    const signal = AbortSignal.any([w.controller.signal, this.network.signal]);
    const worker = this.indexSettings(w, epoch, signal).catch(error => {
      if (this.current(w, epoch) && !signal.aborted) w.error = error instanceof SearchIndexBusyError ? error.message : PROVIDER_WARNING;
    }).finally(() => {
      if (w.worker === worker) delete w.worker;
      // Revocation may have interrupted a batch while a config/query scheduled its replacement.
      if (this.current(w) && epoch !== this.epoch) this.schedule(w);
    });
    w.worker = worker;
  }
  private async indexSettings(w: Workspace, epoch: number, signal: AbortSignal): Promise<void> {
    await this.store.write(w.cwd, signal, async tx => {
      const cache = await tx.load();
      while (this.current(w, epoch)) {
        const missing = new Map<string, string>();
        for (const document of w.settings) for (const text of document.chunks) {
          const hash = hashText(text);
          if (!cache.vectors.has(hash)) missing.set(hash, text);
        }
        if (!missing.size || !await this.consent(signal)) break;
        if (!this.current(w, epoch)) return;
        const batch: [string, string][] = [];
        let size = 0;
        for (const pair of missing) {
          if (batch.length === 16 || size + pair[1].length > 16000) break;
          batch.push(pair); size += pair[1].length;
        }
        const vectors = await this.vectors(batch.map(([, text]) => text), signal);
        if (!this.current(w, epoch)) return;
        batch.forEach(([hash], index) => cache.vectors.set(hash, vectors[index]!));
        await tx.save(w.settings, cache.vectors);
      }
      if (!this.current(w, epoch)) return;
      await tx.save(w.settings, cache.vectors);
      w.cache = cache;
      w.migrated = true; delete w.indexError;
      if (w.error === PROVIDER_WARNING || w.error === "Search index busy; update deferred") delete w.error;
    });
  }
  async query(request: SearchQueryRequest, caller = new AbortController().signal): Promise<SearchQueryResponse> {
    caller.throwIfAborted();
    const w = await this.activate(request.cwd);
    const signal = AbortSignal.any([caller, w.controller.signal]);
    await this.consent(signal);
    const epoch = this.epoch;
    const wantsSettings = request.types.includes("settings");
    const settings = wantsSettings ? settingsDocuments(request.settings) : [];
    if (wantsSettings) { w.settings = settings; this.schedule(w); }
    const wantsSessions = request.types.includes("sessions");
    let records = wantsSessions ? await this.discover(w, signal) : [];
    if (wantsSessions) {
      await this.reconcileSessions(w, records, signal);
      await this.refreshSessionBoundaries(w, records, signal);
    }
    let queryVector: number[] | undefined;
    const query = request.query.trim();
    const semanticSettings = wantsSettings && w.settings.length > 0 && this.enabled;
    const semanticSessions = wantsSessions && w.namedSessions.length > 0 && this.sessionTitlesEnabled;
    if (query && (semanticSettings || semanticSessions) && this.keyAvailable && this.current(w, epoch)) {
      const owned = AbortSignal.any([signal, this.network.signal]);
      try {
        queryVector = w.queryVectors.get(query);
        if (!queryVector) {
          queryVector = (await this.vectors([query], owned, semanticSettings ? "settings" : "sessions"))[0]!;
          if (this.current(w, epoch)) {
            if (w.queryVectors.size >= 100) w.queryVectors.delete(w.queryVectors.keys().next().value!);
            w.queryVectors.set(query, queryVector);
          }
        }
        if (this.current(w, epoch) && semanticSettings) w.cache = await this.store.read(w.cwd, signal);
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
    if (wantsSessions && queryVector && this.sessionTitlesEnabled) {
      try {
        const embeddings = await this.store.readSessionTitles(w.cwd, signal);
        for (const title of namedSessionTitles(records, w.cwd)) {
          const stored = embeddings.get(title.sessionId);
          if (!stored || stored.hash !== title.hash) continue;
          const similarity = cosine(queryVector, stored.vector);
          if (similarity < 0.25) continue;
          const position = results.findIndex(hit => hit.kind === "sessions" && hit.sessionId === title.sessionId);
          if (position >= 0) {
            const existing = results[position]!;
            results[position] = { ...existing, score: Math.max(existing.score, similarity) };
          }
          else {
            const hit: SessionSearchHit = { kind: "sessions", id: `sessions:${title.sessionId}`,
              sessionId: title.sessionId, title: title.title, snippet: "", score: similarity };
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
    await this.workspace?.worker;
    await this.workspace?.sessionWorker;
    await this.workspace?.migration?.catch(() => {});
    await this.workspace?.refresh.catch(() => {});
    await this.configQueue.catch(() => {});
    this.workspace = undefined;
  }
}
