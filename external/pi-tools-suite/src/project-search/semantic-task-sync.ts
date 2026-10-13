import { watchFile, unwatchFile } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { semanticConfiguration, semanticKey, type SemanticSearchOptions } from "./semantic-provider.js";
import { syncSavedTaskVectors } from "./semantic-task-indexer.js";
import { semanticConfigurationPath } from "./native-embedding-provider.mjs";

export interface TaskSyncServices {
  watch?: (root: string, changed: () => void) => () => void;
  schedule?: (run: () => void, milliseconds: number) => () => void;
  onError?: () => void;
}

/** Stat watchers tolerate initially absent .pi/storage and SQLite WAL
 * replacement/checkpointing. Own only our listeners, not another extension's
 * watcher; never follow events into another project or create storage. */
export function watchTaskFiles(root: string, changed: () => void): () => void {
  const files = [join(root, ".pi", "tasks.sqlite"), join(root, ".pi", "tasks.sqlite-wal"), semanticConfigurationPath()];
  for (const file of files) watchFile(file, { persistent: false, interval: 1000 }, changed);
  return () => { for (const file of files) unwatchFile(file, changed); };
}

function schedule(run: () => void, milliseconds: number): () => void {
  const timer = setTimeout(run, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
}

export interface SavedTaskEmbeddingSync {
  refresh(): void;
  settled(): Promise<void>;
  stop(): Promise<void>;
}

/** One serial worker for the active session project. DB/WAL bursts coalesce;
 * changes during an upload get one follow-up scan. No default provider, opt-in
 * migration or query-triggered task uploads. */
export function startSavedTaskEmbeddingSync(root: string, options: SemanticSearchOptions = {},
  services: TaskSyncServices = {}): SavedTaskEmbeddingSync {
  let owner = new AbortController();
  const defer = services.schedule ?? schedule;
  let running: Promise<void> | undefined;
  let cancelTimer: (() => void) | undefined;
  let timerGeneration = 0;
  let dirty = false;
  let stopped = false;

  function queue(milliseconds: number): void {
    cancelTimer?.();
    const current = ++timerGeneration;
    cancelTimer = defer(() => {
      if (stopped || current !== timerGeneration) return;
      cancelTimer = undefined;
      launch();
    }, milliseconds);
  }
  function refresh(): void {
    if (stopped) return;
    dirty = true;
    queue(250);
  }
  function launch(): void {
    if (stopped || running) return;
    dirty = false;
    const signal = owner.signal;
    running = withSourcePolicy(root, signal, async signal => {
      if (!await sourceEnabled(root, "tasks")) return;
      const config = await semanticConfiguration(options, signal);
      if (!config) return;
      const key = config.provider === "openrouter" ? await semanticKey(options, signal) : undefined;
      if (config.provider === "openrouter" && !key) return;
      await syncSavedTaskVectors(root, key, options, signal, config);
    }).catch(() => {
      if (!stopped) {
        // A later content/configuration change may retry; never loop paid failures.
        services.onError?.();
      }
    }).finally(() => {
      running = undefined;
      if (!stopped && dirty && !cancelTimer) queue(250);
    });
  }
  const unwatch = (services.watch ?? watchTaskFiles)(root, refresh);
  const unwatchPolicy = watchSourcePolicy(root, () => {
    owner.abort(new Error("Search source selection changed"));
    owner = new AbortController();
    refresh();
  });
  // Install ownership before starting bootstrap; the factory itself is inert.
  launch();
  return {
    refresh,
    async settled() { while (running) await running; },
    async stop() {
      if (!stopped) {
        stopped = true;
        timerGeneration++;
        owner.abort(new Error("Saved-task embedding sync stopped"));
        cancelTimer?.(); cancelTimer = undefined;
        unwatch();
        unwatchPolicy();
      }
      await running;
    },
  };
}

export function registerSavedTaskEmbeddingSync(pi: ExtensionAPI, options: SemanticSearchOptions = {},
  services: TaskSyncServices = {}): () => void {
  let active: SavedTaskEmbeddingSync | undefined;
  let generation = 0;
  // Shutdown is emitted on replacement/reload too. Also stop on start for
  // hosts that publish a new context without a preceding shutdown notification.
  pi.on("session_start", async (_event, ctx) => {
    const current = ++generation;
    const previous = active;
    active = undefined;
    await previous?.stop();
    if (current !== generation) return;
    // Canonical project_tasks storage is cwd-owned, not the nearest ancestor
    // Git/package root; never bootstrap another project merely by discovery.
    active = startSavedTaskEmbeddingSync(resolve(ctx.cwd), options, services);
  });
  pi.on("session_shutdown", async () => {
    generation++;
    const previous = active;
    active = undefined;
    await previous?.stop();
  });
  return () => active?.refresh();
}
import { sourceEnabled, watchSourcePolicy, withSourcePolicy } from "./source-policy.mjs";
