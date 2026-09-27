export type GitCiProvider = "github" | "gitlab";
export type GitCiAvailability = "ready" | "noRemote" | "ambiguousRemote" | "unsupportedRemote" | "cliMissing" | "authRequired" | "headChanged" | "error";
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
  readonly headChanged?: boolean;
}

export interface GitCiSetupGuide {
  readonly providerLabel: string;
  readonly cliName: "gh" | "glab";
  readonly host: string;
  readonly installCommand: string;
  readonly authCommand: string;
  readonly installUrl: string;
  readonly authUrl: string;
  readonly needsInstall: boolean;
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

export function gitCiSetupGuide(snapshot: GitCiSnapshot | undefined): GitCiSetupGuide | undefined {
  if (!snapshot?.provider || (snapshot.availability !== "cliMissing" && snapshot.availability !== "authRequired")) {
    return undefined;
  }
  const host = snapshot.host ?? (snapshot.provider === "github" ? "github.com" : "gitlab.com");
  if (snapshot.provider === "github") {
    return {
      providerLabel: "GitHub CLI",
      cliName: "gh",
      host,
      installCommand: "brew install gh",
      authCommand: `gh auth login --hostname ${shellQuote(host)}`,
      installUrl: "https://cli.github.com/",
      authUrl: "https://cli.github.com/manual/gh_auth_login",
      needsInstall: snapshot.availability === "cliMissing",
    };
  }
  return {
    providerLabel: "GitLab CLI",
    cliName: "glab",
    host,
    installCommand: "brew install glab",
    authCommand: `glab auth login --hostname ${shellQuote(host)}`,
    installUrl: "https://docs.gitlab.com/cli/",
    authUrl: "https://docs.gitlab.com/cli/authentication/",
    needsInstall: snapshot.availability === "cliMissing",
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
