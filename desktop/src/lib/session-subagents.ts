import type { SessionStateNotification } from "./session-state";

export const SUBAGENTS_LIVE_STATE_CHANNEL = "pi-tools-suite:async-subagents:live-state";

export type SessionSubagentStatus = "planned" | "running" | "retrying" | "done" | "failed" | "stopped";

export interface SessionSubagentAgent {
  readonly id: string;
  readonly status: SessionSubagentStatus;
  readonly exitCode?: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly nextRetryAt?: string;
  readonly pid?: number;
  readonly resultLines?: number;
  readonly stderrLines?: number;
  readonly eventLines?: number;
  readonly retryCount?: number;
}

export interface SessionSubagentTaskPreview {
  readonly id: string;
  readonly task?: string;
  readonly scope?: string;
  readonly model?: string;
}

export interface SessionSubagentRun {
  readonly runDir: string;
  readonly agents: SessionSubagentAgent[];
  readonly tasks?: SessionSubagentTaskPreview[];
}

export interface SessionSubagentSnapshot {
  readonly version: 1;
  readonly count: number;
  readonly runs: SessionSubagentRun[];
  readonly sessionFile?: string;
  readonly checkedAt: number;
}

const SUBAGENT_STATUSES: readonly SessionSubagentStatus[] = [
  "planned",
  "running",
  "retrying",
  "done",
  "failed",
  "stopped",
];
const ACTIVE_SUBAGENT_STATUSES: readonly SessionSubagentStatus[] = ["planned", "running", "retrying"];

export function sessionSubagentSnapshot(notification: SessionStateNotification): SessionSubagentSnapshot | undefined {
  return notification.channel === SUBAGENTS_LIVE_STATE_CHANNEL && isSessionSubagentSnapshot(notification.data)
    ? notification.data
    : undefined;
}

export function updateSessionSubagentSnapshots(
  current: ReadonlyMap<string, SessionSubagentSnapshot>,
  acpSessionId: string,
  snapshot: SessionSubagentSnapshot,
): Map<string, SessionSubagentSnapshot> {
  const previous = current.get(acpSessionId);
  if (previous && previous.checkedAt > snapshot.checkedAt) return new Map(current);
  const next = new Map(current);
  next.set(acpSessionId, snapshot);
  return next;
}

export function isActiveSessionSubagentStatus(status: SessionSubagentStatus): boolean {
  return ACTIVE_SUBAGENT_STATUSES.includes(status);
}

export function visibleSessionSubagentRuns(snapshot: SessionSubagentSnapshot | undefined): SessionSubagentRun[] {
  return (snapshot?.runs ?? [])
    .map((run) => ({ ...run, agents: run.agents.filter((agent) => isActiveSessionSubagentStatus(agent.status)) }))
    .filter((run) => run.agents.length > 0);
}

export function sessionSubagentCount(snapshot: SessionSubagentSnapshot | undefined): number {
  return visibleSessionSubagentRuns(snapshot).reduce((count, run) => count + run.agents.length, 0);
}

export function sessionSubagentTaskPreview(
  run: SessionSubagentRun,
  agentId: string,
): SessionSubagentTaskPreview | undefined {
  return run.tasks?.find((task) => task.id === agentId);
}

export function sessionSubagentRunName(runDir: string): string {
  return runDir.split(/[\\/]/).filter(Boolean).at(-1) ?? runDir;
}

export function sessionSubagentModelLabel(preview: SessionSubagentTaskPreview | undefined): string {
  const model = preview?.model?.trim();
  return model?.split("/").filter(Boolean).at(-1) ?? "model unknown";
}

export function formatSessionSubagentElapsed(startedAt: string | undefined, now: number): string {
  if (!startedAt) return "queued";
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "elapsed unknown";
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m${remainingSeconds.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

export function isSessionSubagentSnapshot(value: unknown): value is SessionSubagentSnapshot {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!isNonNegativeInteger(value.count) || typeof value.checkedAt !== "number" || !Number.isFinite(value.checkedAt)) return false;
  if (value.sessionFile !== undefined && typeof value.sessionFile !== "string") return false;
  if (!Array.isArray(value.runs) || !value.runs.every(isSessionSubagentRun)) return false;
  if (new Set(value.runs.map((run) => run.runDir)).size !== value.runs.length) return false;
  const activeCount = value.runs.reduce(
    (count, run) => count + run.agents.filter((agent) => isActiveSessionSubagentStatus(agent.status)).length,
    0,
  );
  return value.count === activeCount;
}

function isSessionSubagentRun(value: unknown): value is SessionSubagentRun {
  if (!isRecord(value) || typeof value.runDir !== "string" || !value.runDir.trim()) return false;
  if (!Array.isArray(value.agents) || !value.agents.every(isSessionSubagentAgent)) return false;
  if (new Set(value.agents.map((agent) => agent.id)).size !== value.agents.length) return false;
  if (value.tasks === undefined) return true;
  return Array.isArray(value.tasks)
    && value.tasks.every(isSessionSubagentTaskPreview)
    && new Set(value.tasks.map((task) => task.id)).size === value.tasks.length;
}

function isSessionSubagentAgent(value: unknown): value is SessionSubagentAgent {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) return false;
  if (typeof value.status !== "string" || !SUBAGENT_STATUSES.includes(value.status as SessionSubagentStatus)) return false;
  if (value.exitCode !== undefined && (typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode))) return false;
  if (value.startedAt !== undefined && typeof value.startedAt !== "string") return false;
  if (value.finishedAt !== undefined && typeof value.finishedAt !== "string") return false;
  if (value.nextRetryAt !== undefined && typeof value.nextRetryAt !== "string") return false;
  if (value.pid !== undefined && (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0)) return false;
  for (const field of ["resultLines", "stderrLines", "eventLines", "retryCount"] as const) {
    if (value[field] !== undefined && !isNonNegativeInteger(value[field])) return false;
  }
  return true;
}

function isSessionSubagentTaskPreview(value: unknown): value is SessionSubagentTaskPreview {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) return false;
  if (value.task !== undefined && typeof value.task !== "string") return false;
  if (value.scope !== undefined && typeof value.scope !== "string") return false;
  return value.model === undefined || typeof value.model === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
