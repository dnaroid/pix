import type { AcpClient } from "../lib/acp-client";
import {
  USAGE_SOURCE_IDS,
  type UsageSourceId,
  type UsageSourceSnapshot,
  type UsageStatsChangedNotification,
} from "../../../acp/src/acp/usage-stats-contract";

type UsageStatsClient = Pick<AcpClient, "usageStats">;

export type UsageStatsStoreOptions = {
  client: () => UsageStatsClient | null;
  workspace: () => string;
  reportError: (error: unknown) => void;
};

/**
 * Usage panel state. Requests run only while the panel is open. Every
 * response is guarded by a scope epoch (client + workspace + open/close)
 * and a per-source sequence, so completions after a workspace switch, ACP
 * reset, close or a newer request for the same source are discarded.
 */
export function createUsageStatsStore(options: UsageStatsStoreOptions) {
  let snapshots = $state<ReadonlyMap<UsageSourceId, UsageSourceSnapshot>>(new Map());
  let busy = $state(false);
  let active = false;
  let disposed = false;
  let epoch = 0;
  let inflight = 0;
  let scopeClient: UsageStatsClient | null = null;
  let scopeCwd = "";
  const sequence = new Map<UsageSourceId, number>();
  let pendingChanged = new Set<UsageSourceId>();
  let changeScheduled = false;

  function resetScope(client: UsageStatsClient | null, cwd: string): void {
    epoch += 1;
    inflight = 0;
    busy = false;
    sequence.clear();
    pendingChanged = new Set();
    if (client !== scopeClient || cwd !== scopeCwd) snapshots = new Map();
    scopeClient = client;
    scopeCwd = cwd;
  }

  function ensureScope(): { client: UsageStatsClient; cwd: string } | null {
    const client = options.client();
    const cwd = options.workspace();
    if (client !== scopeClient || cwd !== scopeCwd) resetScope(client, cwd);
    return client && cwd ? { client, cwd } : null;
  }

  async function request(sources: readonly UsageSourceId[] | undefined, refresh: boolean): Promise<void> {
    if (disposed || !active) return;
    const scope = ensureScope();
    if (!scope) return;
    const owner = epoch;
    const ids = sources ?? USAGE_SOURCE_IDS;
    const tokens = new Map<UsageSourceId, number>();
    for (const id of ids) {
      const next = (sequence.get(id) ?? 0) + 1;
      sequence.set(id, next);
      tokens.set(id, next);
    }
    inflight += 1;
    busy = true;
    try {
      const response = await scope.client.usageStats(scope.cwd, {
        ...(sources ? { sources } : {}),
        ...(refresh ? { refresh: true } : {}),
      });
      if (owner !== epoch || disposed) return;
      let next: Map<UsageSourceId, UsageSourceSnapshot> | undefined;
      for (const snapshot of response.snapshots) {
        const token = tokens.get(snapshot.source);
        if (token === undefined || sequence.get(snapshot.source) !== token) continue;
        next ??= new Map(snapshots);
        next.set(snapshot.source, snapshot);
      }
      if (next) snapshots = next;
    } catch (error) {
      if (owner === epoch && !disposed) options.reportError(error);
    } finally {
      if (owner === epoch) {
        inflight = Math.max(0, inflight - 1);
        busy = inflight > 0;
      }
    }
  }

  function flushChanged(): void {
    changeScheduled = false;
    if (!active || disposed || pendingChanged.size === 0) return;
    const sources = [...pendingChanged];
    pendingChanged = new Set();
    void request(sources, false);
  }

  return {
    get snapshots(): ReadonlyMap<UsageSourceId, UsageSourceSnapshot> { return snapshots; },
    get busy(): boolean { return busy; },
    get active(): boolean { return active; },
    snapshot(source: UsageSourceId): UsageSourceSnapshot | undefined { return snapshots.get(source); },

    /** Panel opened: show retained data and fetch. */
    open(): Promise<void> {
      if (disposed) return Promise.resolve();
      active = true;
      return request(undefined, false);
    },
    /** Panel closed: drop in-flight completions, keep cached data for reopen. */
    close(): void {
      active = false;
      resetScope(scopeClient, scopeCwd);
    },
    refresh(): Promise<void> {
      return request(undefined, true);
    },
    /** Workspace or connection changed while open; re-request in the new scope. */
    sync(): Promise<void> {
      if (!active || disposed) return Promise.resolve();
      return request(undefined, false);
    },
    handleChanged(notification: UsageStatsChangedNotification): void {
      if (!active || disposed) return;
      pendingChanged.add(notification.source);
      if (changeScheduled) return;
      changeScheduled = true;
      queueMicrotask(flushChanged);
    },
    dispose(): void {
      disposed = true;
      active = false;
      resetScope(null, "");
    },
  };
}

export type UsageStatsStore = ReturnType<typeof createUsageStatsStore>;
