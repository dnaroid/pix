import {
  isCanonicalProjectPlanPath,
} from "../lib/project-documents";
import {
  loadPlanLaunches,
  savePlanLaunches,
  withPlanLaunch,
  withPlanLaunchOutcome,
  type PlanLaunchOutcome,
  type PlanLaunchStorage,
  type PlanLaunches,
} from "../lib/plan-launches";

/** One launch of a plan as seen by the UI; `live` covers the gap before the prompt starts. */
export type PlanLaunchRun = { sessionId: string; launchedAt: number; outcome?: PlanLaunchOutcome; live: boolean };

/** Workspace-scoped, persisted map of session id -> launched saved plan. */
export function createPlanLaunchesStore(storage?: PlanLaunchStorage, now: () => number = Date.now) {
  // The cache is plain data; `version` is the reactive dependency for readers.
  let version = $state(0);
  const cache = new Map<string, PlanLaunches>();
  // Launches whose start sequence (session creation → prompt) has not settled yet.
  // In-memory only: after a restart an unsettled launch falls back to the saved checklist.
  const live = new Set<string>();

  function launches(workspace: string): PlanLaunches {
    let value = cache.get(workspace);
    if (!value) {
      value = loadPlanLaunches(workspace, storage);
      cache.set(workspace, value);
    }
    return value;
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
    record(workspace: string, sessionId: string, path: string): void {
      if (!workspace || !sessionId || !isCanonicalProjectPlanPath(path)) return;
      const next = withPlanLaunch(launches(workspace), sessionId, path, now());
      cache.set(workspace, next);
      savePlanLaunches(workspace, next, storage);
      live.add(sessionId);
      version += 1;
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
        const current = launches(candidate);
        if (!current[sessionId]) continue;
        const next = withPlanLaunchOutcome(current, sessionId, outcome, now());
        cache.set(candidate, next);
        savePlanLaunches(candidate, next, storage);
        version += 1;
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
  };
}

export type PlanLaunchesStore = ReturnType<typeof createPlanLaunchesStore>;
