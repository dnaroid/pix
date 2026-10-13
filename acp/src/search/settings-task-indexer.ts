import { setImmediate as yieldTask } from "node:timers/promises";
import type { SearchSetting } from "./contract.js";
import type { SemanticEmbeddingConfig } from "./config.js";
import { hashText, settingsDocuments, settingsFingerprint, type SearchDocument } from "./documents.js";
import { SearchIndexBusyError, SearchIndexStore } from "./index-store.js";
import { SearchCacheCompatibilityError } from "./embedding-cache.js";
import { readTaskSemanticCorpus } from "./task-corpus.js";
import type { TaskSemanticDocument } from "./task-index.js";
import { watchTaskChanges, type TaskChangeWatcher } from "./task-watcher.js";
import { bounded } from "./bounded.js";

type Source = "settings" | "tasks";
interface Work {
  revision: number;
  automatic: boolean;
  controller: AbortController;
  worker?: Promise<void>;
  error?: string;
}
interface Options {
  cwd: string;
  signal: AbortSignal;
  config: SemanticEmbeddingConfig;
  store: SearchIndexStore;
  embed(inputs: readonly string[], signal: AbortSignal, domain: Source): Promise<number[][]>;
  authorized(signal: AbortSignal, source: Source): Promise<boolean>;
  enabled?(source: Source): boolean;
  completed?(source: Source): void;
  watchTasks?: TaskChangeWatcher | undefined;
  debounceMs?: number | undefined;
}
const fingerprintTasks = (tasks: readonly TaskSemanticDocument[]) => hashText(JSON.stringify(
  tasks.map(task => [task.id, task.hash]).sort((a, b) => a[0]!.localeCompare(b[0]!))));
class CorpusChanged extends Error {}
// Background sources share the writer with provider-backed batches, not just short local writes.

/** Workspace-owned, change-driven indexing. A failed fingerprint is not retried
 * by status reads, queries or a timer. Explicit sync can retry once. */
export class SettingsTaskIndexer {
  private readonly work: Record<Source, Work> = {
    settings: { revision: 0, automatic: false, controller: new AbortController() },
    tasks: { revision: 0, automatic: false, controller: new AbortController() },
  };
  private settings: SearchDocument[] = [];
  private settingsHash?: string;
  private tasksHash: string | undefined;
  private watchError: string | undefined;
  private stopWatch: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scanRevision = 0;
  private scans = new Set<Promise<void>>();
  private closed = false;
  constructor(private readonly options: Options) {
    options.signal.addEventListener("abort", this.stop, { once: true });
    if (options.signal.aborted) this.stop();
  }
  get indexing(): { settings: boolean; tasks: boolean } {
    return { settings: Boolean(this.work.settings.worker), tasks: Boolean(this.work.tasks.worker) };
  }
  get checking(): { tasks: boolean } {
    return { tasks: !this.closed && Boolean(this.scans.size || this.timer) };
  }
  get errors(): { settings?: string; tasks?: string } {
    return { ...(this.work.settings.error ? { settings: this.work.settings.error } : {}),
      ...((this.work.tasks.error ?? this.watchError) ? { tasks: this.work.tasks.error ?? this.watchError! } : {}) };
  }
  /** Query compatibility supplies settings only; it never starts task ownership. */
  catalogue(settings: readonly SearchSetting[], retry = false, schedule = true): void {
    if (this.options.enabled?.("settings") === false) return;
    const documents = settingsDocuments(settings);
    const hash = settingsFingerprint(documents);
    if (hash !== this.settingsHash) {
      this.settings = documents; this.settingsHash = hash;
      this.invalidate("settings"); this.work.settings.automatic = schedule;
      if (schedule) this.schedule("settings");
    } else if (retry && schedule) { this.work.settings.automatic = true; this.schedule("settings"); }
  }
  /** One selected-source pass. No watcher bootstrap and no other-source retry. */
  async index(source: Source, settings: readonly SearchSetting[], caller: AbortSignal): Promise<void> {
    if (this.options.enabled?.(source) === false) throw new Error("Search source disabled");
    if (source === "settings") this.catalogue(settings, false, false);
    const work = this.work[source];
    const previous = work.worker;
    let previousSettled = !previous;
    let revision = work.revision;
    const lifetime = AbortSignal.any([caller, this.options.signal]);
    const operation = (async () => {
      await bounded(lifetime, undefined, () => previous?.catch(() => {}).finally(() => { previousSettled = true; }) ?? Promise.resolve());
      lifetime.throwIfAborted();
      if (source === "settings" && revision !== work.revision) throw new CorpusChanged();
      if (source === "tasks") {
        const scan = ++this.scanRevision;
        const documents = await readTaskSemanticCorpus(this.options.cwd, lifetime);
        if (scan !== this.scanRevision) throw new CorpusChanged();
        const hash = fingerprintTasks(documents);
        if (hash !== this.tasksHash) { this.tasksHash = hash; this.invalidate(source); work.automatic = false; }
      }
      revision = work.revision;
      const signal = AbortSignal.any([lifetime, work.controller.signal]);
      await this.drain(source, signal, true);
      signal.throwIfAborted();
      delete work.error;
      this.options.completed?.(source);
    })().catch(error => {
      if (!this.closed && !lifetime.aborted && revision === work.revision) work.error = error instanceof SearchIndexBusyError || error instanceof SearchCacheCompatibilityError
        ? error.message : `Semantic ${source === "tasks" ? "task" : "settings"} search unavailable; local search remains available`;
      throw error;
    }).finally(() => {
      if (work.worker === operation) {
        if (previous && !previousSettled) work.worker = previous;
        else delete work.worker;
      }
      // Preserve change-driven automatic sync, but never retry a failed click.
      if (!this.closed && !lifetime.aborted && revision !== work.revision) this.schedule(source);
    });
    work.worker = operation;
    await operation;
  }
  sync(settings: readonly SearchSetting[]): void {
    if (this.closed) return;
    this.catalogue(settings, true);
    if (this.options.enabled?.("tasks") === false) return;
    if (!this.stopWatch) {
      let failed = false;
      this.watchError = undefined;
      const stop = (this.options.watchTasks ?? watchTaskChanges)(this.options.cwd, () => this.debounce(), () => {
        failed = true;
        this.watchError = "Task change watcher unavailable; sync to refresh task indexing";
        this.stopWatch?.(); this.stopWatch = undefined;
      });
      if (failed) stop(); else this.stopWatch = stop;
    }
    this.refreshTasks(true);
  }
  private invalidate(source: Source): void {
    const work = this.work[source];
    work.revision++; work.controller.abort(); work.controller = new AbortController();
  }
  private debounce(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; this.refreshTasks(); }, this.options.debounceMs ?? 75);
    this.timer.unref();
  }
  private refreshTasks(retry = false): void {
    if (this.closed || this.options.enabled?.("tasks") === false) return;
    const revision = ++this.scanRevision;
    const operation = readTaskSemanticCorpus(this.options.cwd, this.options.signal).then(documents => {
      if (this.closed || revision !== this.scanRevision) return;
      const hash = fingerprintTasks(documents);
      if (hash !== this.tasksHash) {
        this.tasksHash = hash;
        this.invalidate("tasks"); this.work.tasks.automatic = true; this.schedule("tasks");
      } else if (retry) { this.work.tasks.automatic = true; this.schedule("tasks"); }
    }).catch(() => {
      if (!this.closed && revision === this.scanRevision) {
        // Invalid canonical content must fence a batch already in flight.
        this.tasksHash = undefined;
        this.invalidate("tasks");
        this.work.tasks.error = "Task corpus unavailable; local task search remains available";
      }
    }).finally(() => this.scans.delete(operation));
    this.scans.add(operation);
  }
  private schedule(source: Source): void {
    const work = this.work[source];
    if (this.closed || !work.automatic || work.worker || (source === "tasks" && this.tasksHash === undefined)) return;
    const revision = work.revision;
    const signal = AbortSignal.any([this.options.signal, work.controller.signal]);
    const operation = this.drain(source, signal).then(() => {
      if (!signal.aborted) { delete work.error; this.options.completed?.(source); }
    }).catch(error => {
      if (this.closed || signal.aborted) return;
      if (error instanceof CorpusChanged) { this.refreshTasks(); return; }
      work.error = error instanceof SearchIndexBusyError || error instanceof SearchCacheCompatibilityError ? error.message
        : `Semantic ${source === "tasks" ? "task" : "settings"} search unavailable; local search remains available`;
    }).finally(() => {
      if (work.worker === operation) delete work.worker;
      if (!this.closed && revision !== work.revision) this.schedule(source);
    });
    work.worker = operation;
  }
  private async drain(source: Source, signal: AbortSignal, retry = false): Promise<void> {
    while (!this.closed) {
      signal.throwIfAborted();
      if (!await this.options.authorized(signal, source)) return;
      let pending = false;
      await this.options.store.write(this.options.cwd, signal, async tx => {
        if (source === "settings") {
          const documents = this.settings;
          const cache = await tx.load(documents);
          const missing = new Map<string, string>();
          for (const document of documents) for (const chunk of document.chunks) {
            const hash = hashText(chunk);
            if (!cache.vectors.has(hash)) missing.set(hash, chunk);
          }
          const batch = [...missing].slice(0, 16);
          pending = batch.length > 0;
          if (pending) {
            const vectors = await tx.outside(() => this.options.embed(batch.map(([, text]) => text), signal, source));
            signal.throwIfAborted();
            if (!await this.options.authorized(signal, source)) throw new Error("Search authorization revoked");
            batch.forEach(([hash], index) => cache.vectors.set(hash, vectors[index]!));
          }
          await tx.save(documents, cache.vectors);
        } else {
          const documents = await readTaskSemanticCorpus(this.options.cwd, signal);
          if (fingerprintTasks(documents) !== this.tasksHash) throw new CorpusChanged();
          const index = tx.tasks();
          index.reconcile(documents);
          const batch = index.missing(16);
          pending = batch.length > 0;
          if (pending) {
            const vectors = await tx.outside(() => this.options.embed(batch.map(task => task.text), signal, source));
            signal.throwIfAborted();
            if (!await this.options.authorized(signal, source)) throw new Error("Search authorization revoked");
            const latest = await readTaskSemanticCorpus(this.options.cwd, signal);
            if (fingerprintTasks(latest) !== this.tasksHash) throw new CorpusChanged();
            index.save(new Map(batch.map((task, position) => [task.hash, vectors[position]!] as const)));
          }
        }
      }, this.options.config, { source, retry });
      retry = false;
      if (!pending) return;
      await yieldTask(undefined, { signal });
    }
  }
  private stop = (): void => {
    if (this.closed) return;
    this.closed = true; this.scanRevision++;
    this.stopWatch?.(); this.stopWatch = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.work.settings.controller.abort(); this.work.tasks.controller.abort();
    this.options.signal.removeEventListener("abort", this.stop);
  };
  async dispose(): Promise<void> {
    this.stop();
    await Promise.allSettled([this.work.settings.worker, this.work.tasks.worker, ...this.scans]);
  }
}
