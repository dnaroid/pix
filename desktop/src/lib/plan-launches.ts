import type { StopReason } from "@agentclientprotocol/sdk";
import { isCanonicalProjectPlanPath, type PlanProgress } from "./project-documents";

/** How the last prompt of a plan-launched session ended. */
export type PlanLaunchOutcome = "completed" | "cancelled" | "failed";
/** Which saved plan a Desktop session was launched from (presentation metadata only). */
export type PlanLaunch = { path: string; launchedAt: number; outcome?: PlanLaunchOutcome; settledAt?: number };
export type PlanLaunches = Readonly<Record<string, PlanLaunch>>;
/** User-facing status of one plan run. */
export type PlanRunStatus = "running" | "done" | "failed" | "interrupted";

export interface PlanLaunchStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const PLAN_LAUNCH_LIMIT = 50;
const OUTCOMES: readonly PlanLaunchOutcome[] = ["completed", "cancelled", "failed"];

export function planLaunchesKey(workspace: string): string {
  return `pix.desktop.planLaunches:${workspace}`;
}

export function loadPlanLaunches(workspace: string, storage?: PlanLaunchStorage): PlanLaunches {
  if (!workspace) return {};
  try {
    const parsed: unknown = JSON.parse((storage ?? localStorage).getItem(planLaunchesKey(workspace)) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const launches: Record<string, PlanLaunch> = {};
    for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!sessionId || !value || typeof value !== "object") continue;
      const { path, launchedAt, outcome, settledAt } = value as Record<string, unknown>;
      if (typeof path !== "string" || !isCanonicalProjectPlanPath(path)) continue;
      if (typeof launchedAt !== "number" || !Number.isFinite(launchedAt)) continue;
      const launch: PlanLaunch = { path, launchedAt };
      // A malformed outcome only loses the status, never the launch itself.
      if (OUTCOMES.includes(outcome as PlanLaunchOutcome) && typeof settledAt === "number" && Number.isFinite(settledAt)) {
        launch.outcome = outcome as PlanLaunchOutcome;
        launch.settledAt = settledAt;
      }
      launches[sessionId] = launch;
    }
    return boundPlanLaunches(launches);
  } catch {
    return {};
  }
}

export function withPlanLaunch(launches: PlanLaunches, sessionId: string, path: string, launchedAt: number): PlanLaunches {
  return boundPlanLaunches({ ...launches, [sessionId]: { path, launchedAt } });
}

/** Records the latest prompt outcome of a known launch; unknown sessions are ignored. */
export function withPlanLaunchOutcome(
  launches: PlanLaunches,
  sessionId: string,
  outcome: PlanLaunchOutcome,
  settledAt: number,
): PlanLaunches {
  const launch = launches[sessionId];
  if (!launch) return launches;
  return { ...launches, [sessionId]: { ...launch, outcome, settledAt } };
}

export function planLaunchOutcome(stopReason: StopReason): PlanLaunchOutcome {
  if (stopReason === "end_turn") return "completed";
  if (stopReason === "cancelled") return "cancelled";
  return "failed";
}

/**
 * Status of a run. A prompt in flight is running; otherwise the recorded outcome
 * decides, and a completed turn that left saved checklist items open is
 * interrupted (resumable). Without an outcome (app quit mid-run, legacy record)
 * the saved checklist alone decides.
 */
export function planRunStatus(
  launch: Pick<PlanLaunch, "outcome">,
  running: boolean,
  progress: PlanProgress | null | undefined,
): PlanRunStatus {
  if (running) return "running";
  if (launch.outcome === "failed") return "failed";
  if (launch.outcome === "cancelled") return "interrupted";
  const unfinished = !!progress && progress.total > 0 && progress.completed < progress.total;
  return unfinished ? "interrupted" : "done";
}

export function planRunResumable(status: PlanRunStatus): boolean {
  return status === "failed" || status === "interrupted";
}

function boundPlanLaunches(launches: Record<string, PlanLaunch>): PlanLaunches {
  const entries = Object.entries(launches);
  if (entries.length <= PLAN_LAUNCH_LIMIT) return launches;
  return Object.fromEntries(entries.sort((a, b) => b[1].launchedAt - a[1].launchedAt).slice(0, PLAN_LAUNCH_LIMIT));
}

export function savePlanLaunches(workspace: string, launches: PlanLaunches, storage?: PlanLaunchStorage): void {
  if (!workspace) return;
  try {
    (storage ?? localStorage).setItem(planLaunchesKey(workspace), JSON.stringify(launches));
  } catch {
    // Presentation metadata is best-effort; the session itself is unaffected.
  }
}
