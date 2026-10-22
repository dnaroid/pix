import type { AcpClient, RuntimeStatus } from "../lib/acp-client";
import { createDiagnosticLogger } from "../lib/diagnostic-logging";
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
const QUOTA_STORAGE_KEY = "pix.desktop.providerUsageQuota.v1";
const MAX_CACHED_ROWS = 64;
const diagnostics = createDiagnosticLogger(() => ({ workspace: "" }));
/**
 * Account quotas are global (not per project or connection): one app-wide snapshot,
 * persisted so a remount, project switch, reconnect or restart renders rows immediately.
 * Credential scope checks on refresh still discard rows from another login.
 */
let quotaCache: QuotaCacheEntry | undefined;

function storage(): Storage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
}

function isCachedEntry(value: unknown): value is ProviderUsageEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.modelRef === "string" && typeof entry.provider === "string"
    && (entry.state === "ready" || entry.state === "unavailable" || entry.state === "failed" || entry.state === "loading")
    && (entry.runtime === undefined || (typeof entry.runtime === "object" && entry.runtime !== null));
}

function cachedQuota(): QuotaCacheEntry | undefined {
  if (quotaCache) return quotaCache;
  try {
    const raw = storage()?.getItem(QUOTA_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { entries?: unknown; cacheScope?: unknown };
    if (!Array.isArray(parsed.entries) || parsed.entries.length > MAX_CACHED_ROWS || !parsed.entries.every(isCachedEntry)) return undefined;
    const cacheScope = typeof parsed.cacheScope === "string" ? parsed.cacheScope : undefined;
    // Never restore an in-flight skeleton as if it were data.
    const entries = parsed.entries.filter((entry) => entry.state !== "loading" || entry.runtime?.modelUsage);
    return quotaCache = { entries, cacheScope };
  } catch (error) {
    diagnostics.report(error, "frontend:provider-usage-cache");
    return undefined;
  }
}

function rememberQuota(next: QuotaCacheEntry): void {
  quotaCache = next;
  try {
    storage()?.setItem(QUOTA_STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    diagnostics.report(error, "frontend:provider-usage-cache");
  }
}

/** Test hook: forget the in-memory app-wide quota snapshot. */
export function resetProviderUsageCacheForTests(): void {
  quotaCache = undefined;
}

/** Sessionless quota polling while Provider limits is expanded, not tied to the active model. */
export function createProviderUsageStore(options: {
  client: () => UsageClient | null;
  workspace: () => string;
  reportError: (error: unknown) => void;
}) {
  let scopeClient: UsageClient | null = options.client();
  let scopeWorkspace = options.workspace();
  const initial = cachedQuota();
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
    rememberQuota({ entries: next, cacheScope });
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
      // Quotas are account-wide: keep showing the app-wide snapshot across projects/reconnects.
      const cached = cachedQuota();
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
