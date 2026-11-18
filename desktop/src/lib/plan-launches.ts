import type { StopReason } from "@agentclientprotocol/sdk";
import type { PlanProgress } from "./project-documents";
import { isCanonicalProjectPlanPath } from "./project-documents";
import {
  boundPlanLaunches,
  parsePlanLaunches,
  PLAN_LAUNCH_LIMIT,
  type PlanLaunch,
  type PlanLaunches,
  type PlanLaunchOutcome,
} from "../../../acp/src/acp/plan-launches-contract";

export { PLAN_LAUNCH_LIMIT };
export type { PlanLaunch, PlanLaunches, PlanLaunchOutcome };
/** User-facing status of one plan run. */
export type PlanRunStatus = "running" | "done" | "failed" | "interrupted";

/** Legacy pre-ACP storage; read once for migration, then removed. */
export interface PlanLaunchStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

export function planLaunchesKey(workspace: string): string {
  return `pix.desktop.planLaunches:${workspace}`;
}

/**
 * Legacy localStorage launches of one workspace, or undefined when there is
 * nothing to migrate. Invalid entries are dropped.
 */
export function readLegacyPlanLaunches(workspace: string, storage?: PlanLaunchStorage): PlanLaunches | undefined {
  if (!workspace) return undefined;
  try {
    const raw = (storage ?? localStorage).getItem(planLaunchesKey(workspace));
    if (raw === null) return undefined;
    return parsePlanLaunches(JSON.parse(raw), isCanonicalProjectPlanPath);
  } catch {
    return {};
  }
}

export function forgetLegacyPlanLaunches(workspace: string, storage?: PlanLaunchStorage): void {
  try {
    (storage ?? localStorage).removeItem(planLaunchesKey(workspace));
  } catch {
    // A leftover key is re-imported idempotently on the next load.
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
