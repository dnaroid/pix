import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitSnapshot } from "../lib/git";
import type { GitCiJobsResult, GitCiSnapshot } from "../lib/git-ci";
import { createGitCiStore } from "./git-ci.svelte";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function gitSnapshot(head: string, ahead = 0): GitSnapshot {
  return {
    branch: "main",
    detached: false,
    head,
    upstream: "origin/main",
    ahead,
    behind: 0,
    remotes: ["origin"],
    branches: [],
    changes: [],
  };
}

function ciSnapshot(headSha: string, runs: GitCiSnapshot["runs"] = []): GitCiSnapshot {
  return {
    provider: "github",
    availability: "ready",
    remoteName: "origin",
    host: "github.com",
    project: "owner/repo",
    headSha,
    localOnly: false,
    runs,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => invoke.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("Git CI lifecycle", () => {
  it("remembers the first sidebar refresh until the initial Git HEAD arrives", async () => {
    const head = "a".repeat(40);
    invoke.mockResolvedValue(ciSnapshot(head));
    const store = createGitCiStore({ workspace: () => "/one" });
    await store.refreshIndicator();
    await store.refreshIndicator();
    expect(invoke).not.toHaveBeenCalled();
    store.updateTarget(gitSnapshot(head));
    await flush();
    expect(invoke.mock.calls.filter(([command]) => command === "git_ci_status")).toHaveLength(1);
    expect(store.snapshot?.headSha).toBe(head);
    store.dispose();
  });

  it("discards a pending first indicator refresh on teardown", async () => {
    const store = createGitCiStore({ workspace: () => "/one" });
    await store.refreshIndicator();
    store.dispose();
    store.updateTarget(gitSnapshot("a".repeat(40)));
    await store.refreshIndicator();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"])("discards %s completion for a run removed from the current snapshot", async (completion) => {
    const head = "a".repeat(40);
    const pending = deferred<GitCiJobsResult>();
    let statusCalls = 0;
    invoke.mockImplementation((command: string) => {
      if (command === "git_ci_status") return Promise.resolve(ciSnapshot(head, statusCalls++ === 0
        ? [{ id: "1", name: "Build", status: "running", rawStatus: "running", headSha: head }]
        : []));
      if (command === "git_ci_jobs") return pending.promise;
      return Promise.resolve(true);
    });
    const store = createGitCiStore({ workspace: () => "/one" });
    store.activate();
    store.updateTarget(gitSnapshot(head));
    await flush();
    store.loadJobs("1");
    await store.refresh();
    if (completion === "resolve") pending.resolve({ runId: "1", jobs: [] });
    else pending.reject(new Error("late removed-run failure"));
    await flush();
    expect(store.jobs.size).toBe(0);
    expect(store.jobsErrors.size).toBe(0);
    expect(store.jobsLoading.size).toBe(0);
    store.dispose();
  });

  it("refreshes a closed-panel indicator once without jobs, overlap or its own timer", async () => {
    vi.useFakeTimers();
    const head = "a".repeat(40);
    const pending = deferred<GitCiSnapshot>();
    invoke.mockImplementation((command: string) => command === "git_ci_status" ? pending.promise : Promise.resolve(true));
    const store = createGitCiStore({ workspace: () => "/one" });
    store.updateTarget(gitSnapshot(head));
    void store.refreshIndicator(); void store.refreshIndicator();
    expect(invoke.mock.calls.filter(([command]) => command === "git_ci_status")).toHaveLength(1);
    pending.resolve(ciSnapshot(head, [{ id: "1", name: "Test", status: "failure", rawStatus: "failure", headSha: head }]));
    await flush();
    expect(store.snapshot?.runs[0]?.status).toBe("failure");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(invoke.mock.calls.filter(([command]) => command === "git_ci_status")).toHaveLength(1);
    expect(invoke.mock.calls.some(([command]) => command === "git_ci_jobs")).toBe(false);
    store.dispose(); vi.useRealTimers();
  });

  it("does not retry missing background CI prerequisites on every tick", async () => {
    const head = "a".repeat(40);
    invoke.mockResolvedValue({ ...ciSnapshot(head), availability: "cliMissing" });
    const store = createGitCiStore({ workspace: () => "/one" });
    store.updateTarget(gitSnapshot(head));
    await store.refreshIndicator(); await store.refreshIndicator();
    expect(invoke.mock.calls.filter(([command]) => command === "git_ci_status")).toHaveLength(1);
    store.dispose();
  });

  it("cancels and ignores a stale status request across a workspace switch", async () => {
    let workspace = "/one";
    const first = deferred<GitCiSnapshot>();
    const second = deferred<GitCiSnapshot>();
    let statusCall = 0;
    invoke.mockImplementation((command: string) => {
      if (command === "git_ci_cancel") return Promise.resolve(true);
      if (command === "git_ci_status") return statusCall++ === 0 ? first.promise : second.promise;
      return Promise.resolve(undefined);
    });
    const store = createGitCiStore({ workspace: () => workspace });
    store.activate();
    const headA = "a".repeat(40);
    const headB = "b".repeat(40);

    store.updateTarget(gitSnapshot(headA));
    const oldRequestId = store.activeStatusRequestId;
    expect(oldRequestId).toBeTruthy();

    workspace = "/two";
    store.updateTarget(gitSnapshot(headB));
    expect(invoke).toHaveBeenCalledWith("git_ci_cancel", { requestId: oldRequestId });

    first.resolve(ciSnapshot(headA));
    await flush();
    expect(invoke.mock.calls.filter(([command]) => command === "git_ci_status")).toHaveLength(2);
    expect(store.snapshot).toBeUndefined();

    second.resolve(ciSnapshot(headB));
    await flush();
    expect(store.snapshot?.headSha).toBe(headB);
    store.dispose();
  });

  it("coalesces repeated refresh requests instead of overlapping status processes", async () => {
    const head = "c".repeat(40);
    const first = deferred<GitCiSnapshot>();
    const second = deferred<GitCiSnapshot>();
    let statusCall = 0;
    invoke.mockImplementation((command: string) => {
      if (command === "git_ci_status") return statusCall++ === 0 ? first.promise : second.promise;
      if (command === "git_ci_cancel") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    const store = createGitCiStore({ workspace: () => "/one" });
    store.activate();
    store.updateTarget(gitSnapshot(head));

    void store.refresh(true);
    void store.refresh(true);
    expect(invoke.mock.calls.filter(([command]) => command === "git_ci_status")).toHaveLength(1);

    first.resolve(ciSnapshot(head));
    await flush();
    expect(invoke.mock.calls.filter(([command]) => command === "git_ci_status")).toHaveLength(2);

    second.resolve(ciSnapshot(head));
    await flush();
    expect(store.snapshot?.headSha).toBe(head);
    store.dispose();
  });

  it("cancels active native work and never publishes it after dispose", async () => {
    const head = "d".repeat(40);
    const pending = deferred<GitCiSnapshot>();
    invoke.mockImplementation((command: string) => {
      if (command === "git_ci_status") return pending.promise;
      if (command === "git_ci_cancel") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    const store = createGitCiStore({ workspace: () => "/one" });
    store.activate();
    store.updateTarget(gitSnapshot(head));
    const requestId = store.activeStatusRequestId;

    store.dispose();
    expect(invoke).toHaveBeenCalledWith("git_ci_cancel", { requestId });
    pending.resolve(ciSnapshot(head));
    await flush();
    expect(store.snapshot).toBeUndefined();
    expect(store.loading).toBe(false);
  });

  it("loads jobs one run at a time and drops jobs from an obsolete target", async () => {
    let workspace = "/one";
    const headA = "e".repeat(40);
    const headB = "f".repeat(40);
    const jobsA = deferred<GitCiJobsResult>();
    const jobsB = deferred<GitCiJobsResult>();
    let jobsCall = 0;
    invoke.mockImplementation((command: string, payload: Record<string, unknown>) => {
      if (command === "git_ci_status") {
        const head = String(payload.expectedHead);
        return Promise.resolve(ciSnapshot(head, [
          { id: "1", name: "Build", status: "success", rawStatus: "success", headSha: head },
          { id: "2", name: "Test", status: "running", rawStatus: "running", headSha: head },
        ]));
      }
      if (command === "git_ci_jobs") return jobsCall++ === 0 ? jobsA.promise : jobsB.promise;
      if (command === "git_ci_cancel") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    const store = createGitCiStore({ workspace: () => workspace });
    store.activate();
    store.updateTarget(gitSnapshot(headA));
    await flush();

    store.loadJobs("1");
    store.loadJobs("2");
    expect(invoke.mock.calls.filter(([command]) => command === "git_ci_jobs")).toHaveLength(1);

    const jobsRequestId = invoke.mock.calls.find(([command]) => command === "git_ci_jobs")?.[1]?.requestId;
    workspace = "/two";
    store.updateTarget(gitSnapshot(headB));
    expect(invoke).toHaveBeenCalledWith("git_ci_cancel", { requestId: jobsRequestId });

    jobsA.resolve({ runId: "1", jobs: [{ id: "job-old", name: "old", status: "success", rawStatus: "success" }] });
    await flush();
    expect(store.jobs.size).toBe(0);
    expect(invoke.mock.calls.filter(([command]) => command === "git_ci_jobs")).toHaveLength(1);

    // The queued job belonged to the old target and must not restart after cancellation.
    jobsB.resolve({ runId: "2", jobs: [] });
    store.dispose();
  });

  it("suspends native work while the Git panel is inactive and resumes on activation", async () => {
    const head = "1".repeat(40);
    const first = deferred<GitCiSnapshot>();
    const second = deferred<GitCiSnapshot>();
    let statusCall = 0;
    invoke.mockImplementation((command: string) => {
      if (command === "git_ci_status") return statusCall++ === 0 ? first.promise : second.promise;
      if (command === "git_ci_cancel") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    const store = createGitCiStore({ workspace: () => "/one" });

    store.updateTarget(gitSnapshot(head));
    expect(invoke.mock.calls.filter(([command]) => command === "git_ci_status")).toHaveLength(0);

    store.activate();
    const requestId = store.activeStatusRequestId;
    expect(requestId).toBeTruthy();
    store.deactivate();
    expect(invoke).toHaveBeenCalledWith("git_ci_cancel", { requestId });

    first.resolve(ciSnapshot(head));
    await flush();
    expect(store.snapshot).toBeUndefined();
    expect(invoke.mock.calls.filter(([command]) => command === "git_ci_status")).toHaveLength(1);

    store.activate();
    expect(invoke.mock.calls.filter(([command]) => command === "git_ci_status")).toHaveLength(2);
    second.resolve(ciSnapshot(head));
    await flush();
    expect(store.snapshot?.headSha).toBe(head);
    store.dispose();
  });

  it("refreshes jobs that were opened when the next active-run poll completes", async () => {
    vi.useFakeTimers();
    const head = "2".repeat(40);
    let jobsCall = 0;
    invoke.mockImplementation((command: string, payload: Record<string, unknown>) => {
      if (command === "git_ci_status") {
        return Promise.resolve(ciSnapshot(head, [
          { id: "1", name: "Build", status: "running", rawStatus: "running", headSha: head },
        ]));
      }
      if (command === "git_ci_jobs") {
        jobsCall += 1;
        return Promise.resolve({
          runId: String(payload.runId),
          jobs: [{
            id: "job-1",
            name: "test",
            status: jobsCall === 1 ? "running" : "success",
            rawStatus: jobsCall === 1 ? "running" : "success",
          }],
        });
      }
      if (command === "git_ci_cancel") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    const store = createGitCiStore({ workspace: () => "/one" });
    store.activate();
    store.updateTarget(gitSnapshot(head));
    await flush();

    store.loadJobs("1");
    await flush();
    expect(store.jobs.get("1")?.[0]?.status).toBe("running");

    await vi.advanceTimersByTimeAsync(8_000);
    await flush();
    expect(invoke.mock.calls.filter(([command]) => command === "git_ci_jobs")).toHaveLength(2);
    expect(store.jobs.get("1")?.[0]?.status).toBe("success");
    store.dispose();
  });

  it("treats a changed HEAD as target invalidation instead of a visible CI error", async () => {
    const head = "3".repeat(40);
    const onTargetStale = vi.fn();
    invoke.mockImplementation((command: string) => {
      if (command === "git_ci_status") {
        return Promise.resolve({
          availability: "headChanged",
          headSha: head,
          localOnly: false,
          runs: [],
        } satisfies GitCiSnapshot);
      }
      if (command === "git_ci_cancel") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    const store = createGitCiStore({ workspace: () => "/one", onTargetStale });
    store.activate();
    store.updateTarget(gitSnapshot(head));
    await flush();

    expect(store.error).toBeNull();
    expect(store.snapshot).toBeUndefined();
    expect(onTargetStale).toHaveBeenCalledOnce();
    store.dispose();
  });

  it("treats a changed HEAD during jobs lookup as target invalidation", async () => {
    const head = "4".repeat(40);
    const onTargetStale = vi.fn();
    invoke.mockImplementation((command: string, payload: Record<string, unknown>) => {
      if (command === "git_ci_status") {
        return Promise.resolve(ciSnapshot(head, [
          { id: "1", name: "Build", status: "running", rawStatus: "running", headSha: head },
        ]));
      }
      if (command === "git_ci_jobs") {
        return Promise.resolve({ runId: String(payload.runId), jobs: [], headChanged: true });
      }
      if (command === "git_ci_cancel") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });
    const store = createGitCiStore({ workspace: () => "/one", onTargetStale });
    store.activate();
    store.updateTarget(gitSnapshot(head));
    await flush();
    store.loadJobs("1");
    await flush();

    expect(store.jobsErrors.has("1")).toBe(false);
    expect(onTargetStale).toHaveBeenCalledOnce();
    store.dispose();
  });
});
