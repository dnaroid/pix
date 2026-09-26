import { invoke } from "@tauri-apps/api/core";
import {
  gitCiIsActive,
  type GitCiJob,
  type GitCiJobsResult,
  type GitCiSnapshot,
} from "../lib/git-ci";
import type { GitSnapshot } from "../lib/git";

const ACTIVE_POLL_MS = 8_000;
const IDLE_POLL_MS = 60_000;
const ERROR_POLL_MS = 60_000;

type GitCiStoreOptions = {
  workspace: () => string;
};

function requestScope(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // A deterministic per-instance sequence below is still safe inside one webview.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createGitCiStore(options: GitCiStoreOptions) {
  const scope = requestScope();
  let requestSequence = 0;
  let generation = 0;
  let disposed = false;
  let active = false;
  let targetSignature = "";
  let targetHead: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let statusRequestId: string | undefined;
  let statusQueued = false;
  let jobsRequestId: string | undefined;
  let jobsRunningRunId: string | undefined;
  let jobsQueue: string[] = [];

  let snapshot = $state<GitCiSnapshot | undefined>(undefined);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let jobs = $state<Map<string, GitCiJob[]>>(new Map());
  let jobsLoading = $state<Set<string>>(new Set());
  let jobsErrors = $state<Map<string, string>>(new Map());

  function nextRequestId(kind: "status" | "jobs"): string {
    requestSequence += 1;
    return `ci:${scope}:${kind}:${requestSequence}`;
  }

  function clearTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function cancelNative(requestId: string | undefined): void {
    if (!requestId) return;
    void invoke("git_ci_cancel", { requestId }).catch(() => undefined);
  }

  function clearJobs(): void {
    jobsQueue = [];
    cancelNative(jobsRequestId);
    jobs = new Map();
    jobsLoading = new Set();
    jobsErrors = new Map();
  }

  function updateTarget(git: GitSnapshot | undefined): void {
    const workspace = options.workspace();
    const signature = git?.head
      ? [workspace, git.head, git.upstream ?? "", String(git.ahead), git.remotes.join("\0")].join("\u0001")
      : `${workspace}\u0001`;
    if (signature === targetSignature) return;

    targetSignature = signature;
    targetHead = git?.head;
    generation += 1;
    clearTimer();
    clearJobs();
    snapshot = undefined;
    error = null;
    loading = false;

    if (statusRequestId) {
      statusQueued = Boolean(active && workspace && targetHead);
      cancelNative(statusRequestId);
      return;
    }
    statusQueued = false;
    if (active && workspace && targetHead && !disposed) void refresh(true);
  }

  function pollDelay(value: GitCiSnapshot | undefined): number | undefined {
    if (!value) return undefined;
    if (value.availability === "error") return ERROR_POLL_MS;
    if (value.availability !== "ready") return undefined;
    return value.runs.some((run) => gitCiIsActive(run.status)) ? ACTIVE_POLL_MS : IDLE_POLL_MS;
  }

  function schedule(): void {
    clearTimer();
    if (disposed || !active || !targetHead || !options.workspace()) return;
    const delay = error ? ERROR_POLL_MS : pollDelay(snapshot);
    if (delay === undefined) return;
    const scheduledGeneration = generation;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || scheduledGeneration !== generation) return;
      void refresh();
    }, delay);
  }

  async function refresh(force = false): Promise<void> {
    if (disposed || !active) return;
    const workspace = options.workspace();
    const head = targetHead;
    if (!workspace || !head) return;
    clearTimer();
    if (statusRequestId) {
      if (force) statusQueued = true;
      return;
    }

    const requestGeneration = generation;
    const requestId = nextRequestId("status");
    statusRequestId = requestId;
    loading = true;
    error = null;
    try {
      const next = await invoke<GitCiSnapshot>("git_ci_status", {
        workspace,
        expectedHead: head,
        requestId,
      });
      if (
        disposed
        || requestGeneration !== generation
        || options.workspace() !== workspace
        || targetHead !== head
        || statusRequestId !== requestId
      ) return;
      snapshot = next;
      error = null;
    } catch (reason) {
      if (
        disposed
        || requestGeneration !== generation
        || options.workspace() !== workspace
        || targetHead !== head
        || statusRequestId !== requestId
      ) return;
      snapshot = undefined;
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      if (statusRequestId === requestId) {
        statusRequestId = undefined;
        if (!disposed && requestGeneration === generation) loading = false;
        const queued = statusQueued;
        statusQueued = false;
        if (!disposed && active && queued && targetHead && options.workspace()) {
          queueMicrotask(() => void refresh(true));
        } else if (!disposed && active && requestGeneration === generation) {
          schedule();
        }
      }
    }
  }

  function loadJobs(runId: string): void {
    if (disposed || !active || !snapshot?.runs.some((run) => run.id === runId)) return;
    if (jobs.has(runId) || jobsLoading.has(runId)) return;
    jobsQueue.push(runId);
    jobsLoading = new Set(jobsLoading).add(runId);
    void pumpJobs();
  }

  async function pumpJobs(): Promise<void> {
    if (disposed || !active || jobsRequestId) return;
    const runId = jobsQueue.shift();
    if (!runId) return;
    const workspace = options.workspace();
    const head = targetHead;
    if (!workspace || !head) {
      const nextLoading = new Set(jobsLoading);
      nextLoading.delete(runId);
      jobsLoading = nextLoading;
      return;
    }
    const requestGeneration = generation;
    const requestId = nextRequestId("jobs");
    jobsRequestId = requestId;
    jobsRunningRunId = runId;
    try {
      const result = await invoke<GitCiJobsResult>("git_ci_jobs", {
        workspace,
        expectedHead: head,
        runId,
        requestId,
      });
      if (
        disposed
        || requestGeneration !== generation
        || options.workspace() !== workspace
        || targetHead !== head
        || jobsRequestId !== requestId
        || result.runId !== runId
      ) return;
      const nextJobs = new Map(jobs);
      nextJobs.set(runId, result.jobs);
      jobs = nextJobs;
      const nextErrors = new Map(jobsErrors);
      nextErrors.delete(runId);
      jobsErrors = nextErrors;
    } catch (reason) {
      if (
        disposed
        || requestGeneration !== generation
        || options.workspace() !== workspace
        || targetHead !== head
        || jobsRequestId !== requestId
      ) return;
      const nextErrors = new Map(jobsErrors);
      nextErrors.set(runId, reason instanceof Error ? reason.message : String(reason));
      jobsErrors = nextErrors;
    } finally {
      if (jobsRequestId === requestId) {
        jobsRequestId = undefined;
        jobsRunningRunId = undefined;
        if (!disposed && requestGeneration === generation) {
          const nextLoading = new Set(jobsLoading);
          nextLoading.delete(runId);
          jobsLoading = nextLoading;
        }
        if (!disposed && active && jobsQueue.length > 0) queueMicrotask(() => void pumpJobs());
      }
    }
  }

  function activate(): void {
    if (disposed || active) return;
    active = true;
    if (targetHead && options.workspace()) void refresh(true);
  }

  function deactivate(): void {
    if (disposed || !active) return;
    active = false;
    generation += 1;
    clearTimer();
    statusQueued = false;
    clearJobs();
    cancelNative(statusRequestId);
    loading = false;
  }

  function reset(): void {
    updateTarget(undefined);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    active = false;
    generation += 1;
    clearTimer();
    statusQueued = false;
    jobsQueue = [];
    cancelNative(statusRequestId);
    cancelNative(jobsRequestId);
    snapshot = undefined;
    loading = false;
    error = null;
    jobs = new Map();
    jobsLoading = new Set();
    jobsErrors = new Map();
  }

  return {
    get snapshot() { return snapshot; },
    get loading() { return loading; },
    get error() { return error; },
    get jobs() { return jobs; },
    get jobsLoading() { return jobsLoading; },
    get jobsErrors() { return jobsErrors; },
    activate,
    deactivate,
    updateTarget,
    refresh,
    loadJobs,
    reset,
    dispose,
    // Exposed only to make lifecycle/concurrency tests deterministic.
    get activeStatusRequestId() { return statusRequestId; },
    get activeJobsRunId() { return jobsRunningRunId; },
  };
}
