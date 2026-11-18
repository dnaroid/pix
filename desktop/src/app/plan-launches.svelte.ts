import { isCanonicalProjectPlanPath } from "../lib/project-documents";
import {
  forgetLegacyPlanLaunches,
  readLegacyPlanLaunches,
  withPlanLaunch,
  withPlanLaunchOutcome,
  type PlanLaunchOutcome,
  type PlanLaunchStorage,
  type PlanLaunches,
} from "../lib/plan-launches";
import type { PlanLaunchesRequest } from "../../../acp/src/acp/plan-launches-contract";

/** One launch of a plan as seen by the UI; `live` covers the gap before the prompt starts. */
export type PlanLaunchRun = { sessionId: string; launchedAt: number; outcome?: PlanLaunchOutcome; live: boolean };

/** The ACP surface the store needs; every response is the full project snapshot. */
export interface PlanLaunchesClient {
  planLaunches(request: PlanLaunchesRequest): Promise<PlanLaunches>;
}

export interface PlanLaunchesStoreOptions {
  client: () => PlanLaunchesClient | null;
  /** Handled failures go to the diagnostic logger; the UI keeps its optimistic view. */
  report?: (label: string, error: unknown) => void;
  /** Legacy localStorage, read once per workspace for migration. */
  storage?: PlanLaunchStorage;
  now?: () => number;
}

/**
 * Workspace-scoped cache of the ACP-owned plan-launch records
 * (`.pi/plan-launches.json`, decision 0077). Mutations update the cache
 * optimistically, then the newest response issued for a workspace replaces it,
 * so a stale completion never overwrites a later change. Legacy
 * `pix.desktop.planLaunches:<workspace>` records are imported once and removed.
 */
export function createPlanLaunchesStore(options: PlanLaunchesStoreOptions) {
  const now = options.now ?? Date.now;
  // The cache is plain data; `version` is the reactive dependency for readers.
  let version = $state(0);
  const cache = new Map<string, PlanLaunches>();
  /** Client a workspace was loaded through; a new connection reloads. */
  const loadedWith = new Map<string, PlanLaunchesClient>();
  const loading = new Map<string, Promise<void>>();
  /** Latest issued request per workspace; only its response may replace the cache. */
  const issued = new Map<string, number>();
  let sequence = 0;
  let disposed = false;
  // Launches whose start sequence (session creation → prompt) has not settled yet.
  // In-memory only: after a restart an unsettled launch falls back to the saved checklist.
  const live = new Set<string>();

  function report(label: string, error: unknown): void {
    try { options.report?.(label, error); } catch { /* Diagnostics never affect the store. */ }
  }

  function setLaunches(workspace: string, launches: PlanLaunches): void {
    cache.set(workspace, launches);
    version += 1;
  }

  async function send(workspace: string, request: PlanLaunchesRequest, client: PlanLaunchesClient): Promise<boolean> {
    const ticket = ++sequence;
    issued.set(workspace, ticket);
    const launches = await client.planLaunches(request);
    if (disposed || issued.get(workspace) !== ticket || options.client() !== client) return false;
    setLaunches(workspace, launches);
    return true;
  }

  function load(workspace: string): Promise<void> {
    const client = options.client();
    if (!workspace || !client || disposed) return Promise.resolve();
    if (loadedWith.get(workspace) === client) return Promise.resolve();
    const running = loading.get(workspace);
    if (running) return running;
    const task = (async () => {
      const legacy = readLegacyPlanLaunches(workspace, options.storage);
      const request: PlanLaunchesRequest = legacy && Object.keys(legacy).length > 0
        ? { cwd: workspace, action: "import", launches: legacy }
        : { cwd: workspace, action: "list" };
      try {
        await send(workspace, request, client);
        loadedWith.set(workspace, client);
        // Only an acknowledged import may drop the legacy copy; import is idempotent.
        if (legacy) forgetLegacyPlanLaunches(workspace, options.storage);
      } catch (error) {
        report("plan-launches:load-failed", error);
      }
    })().finally(() => loading.delete(workspace));
    loading.set(workspace, task);
    return task;
  }

  function mutate(workspace: string, request: PlanLaunchesRequest): void {
    const client = options.client();
    if (!client) {
      report("plan-launches:offline", new Error(`${request.action} was not persisted: backend not connected`));
      return;
    }
    send(workspace, request, client).catch((error: unknown) => report(`plan-launches:${request.action}-failed`, error));
  }

  function launches(workspace: string): PlanLaunches {
    const client = options.client();
    if (client && loadedWith.get(workspace) !== client && !loading.has(workspace)) {
      // Readers run inside derived state: start the load outside the reaction.
      queueMicrotask(() => void load(workspace));
    }
    return cache.get(workspace) ?? {};
  }

  function runs(workspace: string, path: string): PlanLaunchRun[] {
    void version;
    if (!workspace) return [];
    return Object.entries(launches(workspace))
      .filter(([, launch]) => launch.path === path)
      .map(([sessionId, launch]) => ({
        sessionId,
        launchedAt: launch.launchedAt,
        ...(launch.outcome ? { outcome: launch.outcome } : {}),
        live: live.has(sessionId),
      }))
      .sort((a, b) => b.launchedAt - a.launchedAt);
  }

  return {
    load,
    record(workspace: string, sessionId: string, path: string): void {
      if (!workspace || !sessionId || !isCanonicalProjectPlanPath(path)) return;
      live.add(sessionId);
      setLaunches(workspace, withPlanLaunch(cache.get(workspace) ?? {}, sessionId, path, now()));
      mutate(workspace, { cwd: workspace, action: "record", sessionId, path });
    },
    /**
     * The prompt started: from now on the prompt runtime reports activity, so a
     * lost settle (e.g. reconnect mid-prompt) cannot leave the run stuck as live.
     */
    started(sessionId: string): void {
      if (live.delete(sessionId)) version += 1;
    },
    /**
     * Records how the latest prompt of a plan session ended. Sessions that were
     * not launched from a plan are ignored. Only cached workspaces are searched
     * when no workspace is given; a recorded launch is always cached.
     */
    settle(sessionId: string, outcome: PlanLaunchOutcome, workspace?: string): void {
      const wasLive = live.delete(sessionId);
      const candidates = workspace ? [workspace] : [...cache.keys()];
      for (const candidate of candidates) {
        const current = cache.get(candidate);
        if (!current?.[sessionId]) continue;
        setLaunches(candidate, withPlanLaunchOutcome(current, sessionId, outcome, now()));
        mutate(candidate, { cwd: candidate, action: "settle", sessionId, outcome });
        return;
      }
      if (wasLive) version += 1;
    },
    /** Sessions launched from one plan, newest first. */
    sessionsFor(workspace: string, path: string): PlanLaunchRun[] {
      return runs(workspace, path);
    },
    launch(workspace: string, sessionId: string | null | undefined): PlanLaunchRun & { path: string } | undefined {
      void version;
      if (!workspace || !sessionId) return undefined;
      const launch = launches(workspace)[sessionId];
      if (!launch) return undefined;
      return {
        path: launch.path,
        sessionId,
        launchedAt: launch.launchedAt,
        ...(launch.outcome ? { outcome: launch.outcome } : {}),
        live: live.has(sessionId),
      };
    },
    get(workspace: string, sessionId: string | null | undefined): string | undefined {
      void version;
      if (!workspace || !sessionId) return undefined;
      return launches(workspace)[sessionId]?.path;
    },
    dispose(): void {
      disposed = true;
    },
  };
}

export type PlanLaunchesStore = ReturnType<typeof createPlanLaunchesStore>;
