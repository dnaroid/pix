import type { AcpClient, RuntimeStatus } from "../lib/acp-client";
import { providerUsageTargets, type ProviderUsageTarget } from "../lib/provider-usage-targets";

export interface ProviderUsageEntry extends ProviderUsageTarget {
  readonly state: "loading" | "ready" | "unavailable" | "failed";
  readonly runtime?: RuntimeStatus;
}

type UsageClient = Pick<AcpClient, "draftConfig">;
const REFRESH_MS = 5 * 60_000;
const CREDENTIAL_RETRY_MS = 60_000;

function failedEntry(entry: ProviderUsageEntry): ProviderUsageEntry {
  const runtime = entry.runtime;
  return {
    ...entry, state: "failed", runtime: runtime ? {
      ...runtime, modelUsageRefresh: "failed",
      ...(runtime.modelUsage ? { modelUsage: { ...runtime.modelUsage, stale: true } } : {}),
    } : undefined,
  };
}

type QuotaCacheEntry = { entries: readonly ProviderUsageEntry[]; cacheScope: string | undefined };
/** Last quota rows per connection and project, so a remounted panel renders them before polling completes. */
const quotaCache = new WeakMap<UsageClient, Map<string, QuotaCacheEntry>>();

function cachedQuota(client: UsageClient | null, workspace: string): QuotaCacheEntry | undefined {
  return client && workspace ? quotaCache.get(client)?.get(workspace) : undefined;
}

/** Sessionless quota polling while Provider limits is expanded, not tied to the active model. */
export function createProviderUsageStore(options: {
  client: () => UsageClient | null;
  workspace: () => string;
  reportError: (error: unknown) => void;
}) {
  let scopeClient: UsageClient | null = options.client();
  let scopeWorkspace = options.workspace();
  const initial = cachedQuota(scopeClient, scopeWorkspace);
  let entries = $state<readonly ProviderUsageEntry[]>(initial?.entries ?? []);
  let cacheScope: string | undefined = initial?.cacheScope;
  let busy = $state(false);
  let error = $state(false);
  let disposed = false;
  let active = true;
  let generation = 0;

  /** Updates rows for the current scope and remembers them for the next mount. */
  function setEntries(next: readonly ProviderUsageEntry[]): void {
    entries = next;
    if (!scopeClient || !scopeWorkspace) return;
    let byWorkspace = quotaCache.get(scopeClient);
    if (!byWorkspace) quotaCache.set(scopeClient, byWorkspace = new Map());
    byWorkspace.set(scopeWorkspace, { entries: next, cacheScope });
  }
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clearTimer(): void {
    clearTimeout(timer);
    timer = undefined;
  }

  function refresh(immediateRetries = 1): Promise<void> {
    if (disposed || !active) return Promise.resolve();
    const client = options.client();
    const workspace = options.workspace();
    const sameScope = client === scopeClient && workspace === scopeWorkspace;
    if (sameScope && pending) return pending;
    clearTimer();
    const owner = ++generation;
    scopeClient = client;
    scopeWorkspace = workspace;
    if (!sameScope) {
      const cached = cachedQuota(client, workspace);
      cacheScope = cached?.cacheScope;
      entries = cached?.entries ?? [];
      error = false;
    }
    busy = false;
    pending = undefined;
    if (!client || !workspace) return Promise.resolve();
    const requestClient = client;
    function current(): boolean {
      return active && !disposed && owner === generation
        && requestClient === options.client() && workspace === options.workspace();
    }

    async function load(): Promise<void> {
      busy = true;
      let retryCredentials = false;
      let cacheInvalidated = false;
      let signalInvalidation!: () => void;
      const invalidated = new Promise<void>((resolve) => { signalInvalidation = resolve; });
      try {
        const catalogue = await requestClient.draftConfig(workspace, undefined, false, true);
        if (!current()) return;
        error = false;
        const nextScope = catalogue.usageCache?.scope;
        const previous = new Map((cacheScope === nextScope ? entries : []).map((entry) => [entry.modelRef, entry]));
        cacheScope = nextScope;
        const saved = new Map(catalogue.usageCache?.snapshots.map((snapshot) => [snapshot.modelKey, snapshot]));
        setEntries(providerUsageTargets(catalogue.configOptions).map((target) => {
          const existing = previous.get(target.modelRef);
          const cached = saved.get(target.modelRef);
          if (cached && (!existing?.runtime?.modelUsage || cached.updatedAt > existing.runtime.modelUsage.updatedAt)) {
            return { ...target, state: "ready", runtime: { sessionId: `quota:${target.modelRef}`, modelUsageRefresh: "skipped", modelUsage: cached } };
          }
          return { ...target, state: existing?.state ?? "loading", runtime: existing?.runtime };
        }));
        const queue = [...entries];
        // Bound concurrent provider queries/catalogue runtimes, including model-specific pools.
        async function worker(): Promise<void> {
          while (current() && !cacheInvalidated) {
            const target = queue.shift();
            if (!target) return;
            let next: ProviderUsageEntry;
            try {
              const result = await requestClient.draftConfig(workspace, { modelRef: target.modelRef }, true, true);
              if (!current() || cacheInvalidated) return;
              const expectedScope = catalogue.usageCache?.routeScopes?.[target.modelRef.split("/")[0]!];
              const mismatched = expectedScope !== undefined && (result.usageCacheScope !== undefined || result.modelUsage !== undefined)
                && result.usageCacheScope !== expectedScope;
              if (result.usageCacheInvalidated || mismatched) {
                cacheInvalidated = true;
                retryCredentials = true;
                cacheScope = undefined;
                setEntries([]);
                signalInvalidation();
                return;
              }
              retryCredentials ||= result.modelUsageCredentialPending === true;
              const usage = result.modelUsage ?? (target.runtime?.modelUsage
                ? { ...target.runtime.modelUsage, stale: true as const } : undefined);
              let state: ProviderUsageEntry["state"] = "unavailable";
              if (result.modelUsageRefresh === "ready" && result.modelUsage) state = "ready";
              if (result.modelUsageRefresh === "failed") {
                state = "failed";
                options.reportError(new Error(`Provider quota refresh failed: ${target.provider}`));
              }
              next = {
                ...target, state,
                runtime: { sessionId: `quota:${target.modelRef}`, modelUsageRefresh: result.modelUsageRefresh, ...(usage ? { modelUsage: usage } : {}) },
              };
            } catch (cause) {
              if (!current() || cacheInvalidated) return;
              options.reportError(cause);
              next = failedEntry(target);
            }
            setEntries(entries.map((entry) => entry.modelRef === target.modelRef ? next : entry));
          }
        }
        // Do not wait for abandoned peers before rereading a changed login.
        await Promise.race([Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker())), invalidated]);
      } catch (cause) {
        if (!current()) return;
        error = true;
        setEntries(entries.map(failedEntry));
        options.reportError(cause);
      } finally {
        if (current()) {
          busy = false;
          pending = undefined;
          if (cacheInvalidated && immediateRetries > 0) await refresh(immediateRetries - 1);
          else timer = setTimeout(() => { void refresh(); }, retryCredentials ? CREDENTIAL_RETRY_MS : REFRESH_MS);
        }
      }
    }
    pending = load();
    return pending;
  }

  return {
    get entries() { return entries; },
    get busy() { return busy; },
    get error() { return error; },
    refresh,
    resume(): Promise<void> {
      active = true;
      return refresh();
    },
    pause(): void {
      active = false;
      generation++;
      clearTimer();
      busy = false;
      pending = undefined;
    },
    dispose(): void {
      disposed = true;
      generation++;
      clearTimer();
      entries = [];
      busy = false;
      pending = undefined;
    },
  };
}
