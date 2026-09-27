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
  readonly canFixWithAi: boolean;
  readonly onFixWithAi: () => Promise<void>;
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

export function gitCiFixPrompt(snapshot: GitCiSnapshot): string {
  const provider = snapshot.provider === "github" ? "GitHub Actions" : snapshot.provider === "gitlab" ? "GitLab CI" : "remote CI";
  const failedRuns = snapshot.runs.filter((run) => run.status === "failure");
  const runLines = failedRuns.length > 0
    ? failedRuns.map((run) => `- ${run.name}${run.url ? ` — ${run.url}` : ""}`).join("\n")
    : "- The current CI snapshot reports a failure; inspect the provider for the failing run(s).";
  return `Fix the failing ${provider} checks for the current branch and keep iterating until CI is green.

Repository CI context:
- Project: ${snapshot.project ?? "current repository"}
- HEAD: ${snapshot.headSha}
- Provider: ${provider}
- Failing runs:\n${runLines}

Work autonomously toward a green CI result, not just an explanation. First inspect git status and preserve unrelated user changes. Use the provider CLI and repository files to inspect the actual failing jobs/logs. Reproduce failures locally when practical, identify and fix the root cause, and run the relevant local checks before pushing. Do not make CI green by disabling checks, skipping tests, or weakening assertions merely to hide the failure; change CI configuration only when it is genuinely the root cause and preserve the intended coverage.

When a fix is ready, commit only the changes needed for the CI repair and push them to the current branch. Do not force-push or rewrite history. Monitor the new remote CI run; if it still fails, inspect the latest failure, make the next fix, commit, push, and monitor again. Continue this edit/test/commit/push/check loop until the current branch CI is green. Stop early only if you are blocked by credentials, permissions, an external outage, or information that requires human input; in that case state the blocker precisely.`;
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
