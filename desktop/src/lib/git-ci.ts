export type GitCiProvider = "github" | "gitlab";
export type GitCiAvailability = "ready" | "noRemote" | "ambiguousRemote" | "unsupportedRemote" | "cliMissing" | "authRequired" | "error";
export type GitCiStatus = "queued" | "running" | "success" | "failure" | "cancelled" | "neutral";

export interface GitCiRun {
  readonly id: string;
  readonly name: string;
  readonly status: GitCiStatus;
  readonly rawStatus: string;
  readonly url?: string;
  readonly branch?: string;
  readonly headSha: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface GitCiJob {
  readonly id: string;
  readonly name: string;
  readonly stage?: string;
  readonly status: GitCiStatus;
  readonly rawStatus: string;
  readonly url?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface GitCiSnapshot {
  readonly provider?: GitCiProvider;
  readonly availability: GitCiAvailability;
  readonly remoteName?: string;
  readonly host?: string;
  readonly project?: string;
  readonly headSha: string;
  readonly localOnly: boolean;
  readonly runs: GitCiRun[];
  readonly error?: string;
}

export interface GitCiJobsResult {
  readonly runId: string;
  readonly jobs: GitCiJob[];
}

export interface GitCiPanelState {
  readonly snapshot: GitCiSnapshot | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  readonly jobs: ReadonlyMap<string, GitCiJob[]>;
  readonly jobsLoading: ReadonlySet<string>;
  readonly jobsErrors: ReadonlyMap<string, string>;
  readonly onActivate: () => void;
  readonly onDeactivate: () => void;
  readonly onRefresh: () => void;
  readonly onLoadJobs: (runId: string) => void;
}

export function gitCiIsActive(status: GitCiStatus): boolean {
  return status === "queued" || status === "running";
}

export function gitCiAggregate(snapshot: GitCiSnapshot | undefined): GitCiStatus | undefined {
  const statuses = snapshot?.runs.map((run) => run.status) ?? [];
  if (!statuses.length) return undefined;
  if (statuses.some((status) => status === "running")) return "running";
  if (statuses.some((status) => status === "queued")) return "queued";
  if (statuses.some((status) => status === "failure")) return "failure";
  if (statuses.some((status) => status === "cancelled")) return "cancelled";
  if (statuses.every((status) => status === "success")) return "success";
  return "neutral";
}

export function gitCiStatusLabel(status: GitCiStatus | undefined): string {
  if (status === "queued") return "queued";
  if (status === "running") return "running";
  if (status === "success") return "passed";
  if (status === "failure") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "neutral") return "complete";
  return "no runs";
}
