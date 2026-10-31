import { invoke } from "@tauri-apps/api/core";
import { createDiagnosticLogger } from "../lib/diagnostic-logging";

export interface OpenRouterBudget {
  readonly limitUsd: number;
  readonly remainingUsd: number;
  readonly resetInterval?: string | null;
  readonly resetsAt?: string | null;
}

/** Mirrors `openrouter_usage::OpenRouterUsage`; amounts are USD. */
export interface OpenRouterUsage {
  readonly balance?: number | null;
  readonly totalCredits?: number | null;
  readonly usageDaily?: number | null;
  readonly usageWeekly?: number | null;
  readonly usageMonthly?: number | null;
  readonly usageTotal?: number | null;
  readonly byokUsageMonthly?: number | null;
  readonly keyLimit?: number | null;
  readonly keyLimitRemaining?: number | null;
  readonly keyLimitReset?: string | null;
  readonly effectiveBudget?: OpenRouterBudget | null;
  readonly isFreeTier?: boolean | null;
}

type Snapshot = { usage: OpenRouterUsage; updatedAt: number };
type Fetcher = () => Promise<OpenRouterUsage | null>;

const STORAGE_KEY = "pix.desktop.openRouterUsage.v1";
const REFRESH_MS = 5 * 60_000;
const diagnostics = createDiagnosticLogger(() => ({ workspace: "" }));
/** App-wide (account-level) snapshot, persisted so the row renders before the first request. */
let cache: Snapshot | null | undefined;

function storage(): Storage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
}

function readCache(): Snapshot | null {
  if (cache !== undefined) return cache;
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Partial<Snapshot> : undefined;
    cache = parsed && typeof parsed.updatedAt === "number" && parsed.usage && typeof parsed.usage === "object"
      ? { usage: parsed.usage, updatedAt: parsed.updatedAt } : null;
  } catch (error) {
    diagnostics.warn("frontend:openrouter-usage-cache", error);
    cache = null;
  }
  return cache;
}

function writeCache(next: Snapshot | null): void {
  cache = next;
  try {
    if (next) storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
    else storage()?.removeItem(STORAGE_KEY);
  } catch (error) {
    diagnostics.warn("frontend:openrouter-usage-cache", error);
  }
}

/** Test hook: forget the in-memory snapshot. */
export function resetOpenRouterUsageCacheForTests(): void {
  cache = undefined;
}

/** Polls OpenRouter balance/spend while Provider limits is expanded; no key → no row. */
export function createOpenRouterUsageStore(options: {
  reportError: (error: unknown) => void;
  fetch?: Fetcher;
}) {
  const fetchUsage: Fetcher = options.fetch ?? (() => invoke<OpenRouterUsage | null>("openrouter_usage"));
  let snapshot = $state<Snapshot | null>(readCache());
  let busy = $state(false);
  let error = $state(false);
  let active = false;
  let disposed = false;
  let generation = 0;
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clearTimer(): void {
    clearTimeout(timer);
    timer = undefined;
  }

  function refresh(): Promise<void> {
    if (disposed || !active) return Promise.resolve();
    if (pending) return pending;
    clearTimer();
    const owner = ++generation;
    const current = () => active && !disposed && owner === generation;
    busy = true;
    pending = (async () => {
      try {
        const usage = await fetchUsage();
        if (!current()) return;
        error = false;
        const next = usage ? { usage, updatedAt: Date.now() } : null;
        snapshot = next;
        writeCache(next);
      } catch (cause) {
        if (!current()) return;
        error = true;
        options.reportError(cause);
      } finally {
        if (current()) {
          busy = false;
          pending = undefined;
          timer = setTimeout(() => { void refresh(); }, REFRESH_MS);
        }
      }
    })();
    return pending;
  }

  return {
    get usage() { return snapshot?.usage; },
    get updatedAt() { return snapshot?.updatedAt; },
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
      busy = false;
      pending = undefined;
    },
  };
}
