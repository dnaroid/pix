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

/** Sessionless quota polling while Provider limits is expanded, not tied to the active model. */
export function createProviderUsageStore(options: {
  client: () => UsageClient | null;
  workspace: () => string;
  reportError: (error: unknown) => void;
}) {
  let entries = $state<readonly ProviderUsageEntry[]>([]);
  let busy = $state(false);
  let error = $state(false);
  let disposed = false;
  let active = true;
  let generation = 0;
  let scopeClient: UsageClient | null = null;
  let scopeWorkspace = "";
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clearTimer(): void {
    clearTimeout(timer);
    timer = undefined;
  }

  function refresh(): Promise<void> {
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
      entries = [];
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
      try {
        const catalogue = await requestClient.draftConfig(workspace);
        if (!current()) return;
        error = false;
        const previous = new Map(entries.map((entry) => [entry.modelRef, entry]));
        entries = providerUsageTargets(catalogue.configOptions).map((target) => ({
          ...target, state: previous.get(target.modelRef)?.state ?? "loading", runtime: previous.get(target.modelRef)?.runtime,
        }));
        const queue = [...entries];
        // Bound concurrent provider queries/catalogue runtimes, including model-specific pools.
        async function worker(): Promise<void> {
          while (current()) {
            const target = queue.shift();
            if (!target) return;
            let next: ProviderUsageEntry;
            try {
              const result = await requestClient.draftConfig(workspace, { modelRef: target.modelRef }, true);
              if (!current()) return;
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
              if (!current()) return;
              options.reportError(cause);
              next = failedEntry(target);
            }
            entries = entries.map((entry) => entry.modelRef === target.modelRef ? next : entry);
          }
        }
        await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker()));
      } catch (cause) {
        if (!current()) return;
        error = true;
        entries = entries.map(failedEntry);
        options.reportError(cause);
      } finally {
        if (current()) {
          busy = false;
          pending = undefined;
          timer = setTimeout(() => { void refresh(); }, retryCredentials ? CREDENTIAL_RETRY_MS : REFRESH_MS);
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
