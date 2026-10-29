import type { SessionStateNotification } from "./session-state";

/** Published by pi-tools-suite background-shell (src/background-shell/index.ts). */
export const BACKGROUND_SHELL_STATE_CHANNEL = "pi-tools-suite:background-shell:state";

export type BackgroundJobStatus = "starting" | "running" | "exited" | "killed" | "failed";

export interface BackgroundJob {
  readonly id: string;
  readonly command: string;
  readonly description?: string;
  readonly status: BackgroundJobStatus;
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly logPath: string;
  readonly tail: string;
}

export interface BackgroundOrphan {
  readonly pid: number;
  readonly command: string;
  readonly startedAt: number;
  readonly logPath: string;
  readonly jobId: string;
}

export interface BackgroundJobsSnapshot {
  readonly checkedAt: number;
  readonly running: number;
  readonly jobs: readonly BackgroundJob[];
  readonly orphans: readonly BackgroundOrphan[];
}

const STATUSES = new Set<BackgroundJobStatus>(["starting", "running", "exited", "killed", "failed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJob(value: unknown): BackgroundJob | undefined {
  if (!isRecord(value)) return undefined;
  const { id, command, status, startedAt, logPath, tail } = value;
  if (typeof id !== "string" || typeof command !== "string" || typeof logPath !== "string") return undefined;
  if (typeof status !== "string" || !STATUSES.has(status as BackgroundJobStatus) || typeof startedAt !== "number") return undefined;
  return {
    id, command, status: status as BackgroundJobStatus, startedAt, logPath,
    tail: typeof tail === "string" ? tail : "",
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.pid === "number" ? { pid: value.pid } : {}),
    ...(typeof value.exitCode === "number" || value.exitCode === null ? { exitCode: value.exitCode as number | null } : {}),
    ...(typeof value.signal === "string" || value.signal === null ? { signal: value.signal as string | null } : {}),
    ...(typeof value.endedAt === "number" ? { endedAt: value.endedAt } : {}),
  };
}

function parseOrphan(value: unknown): BackgroundOrphan | undefined {
  if (!isRecord(value)) return undefined;
  const { pid, command, startedAt, logPath, jobId } = value;
  if (typeof pid !== "number" || typeof command !== "string" || typeof logPath !== "string" || typeof jobId !== "string") return undefined;
  return { pid, command, logPath, jobId, startedAt: typeof startedAt === "number" ? startedAt : 0 };
}

export function parseBackgroundJobsSnapshot(value: unknown): BackgroundJobsSnapshot | undefined {
  if (!isRecord(value) || typeof value.checkedAt !== "number" || !Array.isArray(value.jobs)) return undefined;
  const jobs = value.jobs.map(parseJob).filter((job): job is BackgroundJob => job !== undefined);
  const orphans = Array.isArray(value.orphans)
    ? value.orphans.map(parseOrphan).filter((orphan): orphan is BackgroundOrphan => orphan !== undefined)
    : [];
  return { checkedAt: value.checkedAt, running: jobs.filter(isLiveBackgroundJob).length, jobs, orphans };
}

export function backgroundJobsSnapshot(notification: SessionStateNotification): BackgroundJobsSnapshot | undefined {
  return notification.channel === BACKGROUND_SHELL_STATE_CHANNEL ? parseBackgroundJobsSnapshot(notification.data) : undefined;
}

export function isLiveBackgroundJob(job: BackgroundJob): boolean {
  return job.status === "starting" || job.status === "running";
}

export function backgroundJobStatusLabel(job: BackgroundJob): string {
  if (job.status === "exited") return `exited (${job.exitCode ?? job.signal ?? "?"})`;
  if (job.status === "killed") return job.signal ? `killed (${job.signal})` : "killed";
  return job.status;
}

/** Last non-empty lines of a job tail, bounded for the popover. */
export function backgroundJobTailLines(tail: string, maxLines = 6): string {
  const lines = tail.replace(/\r/g, "").split("\n");
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines.slice(-maxLines).join("\n");
}

/** Workspace-relative path when the log lives inside the project, else undefined. */
export function workspaceRelativePath(workspace: string, path: string): string | undefined {
  const root = workspace.replace(/\/+$/, "");
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
}
