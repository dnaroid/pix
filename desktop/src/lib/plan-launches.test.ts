import { describe, expect, it, vi } from "vitest";
import { forgetLegacyPlanLaunches, PLAN_LAUNCH_LIMIT, planLaunchesKey, planLaunchOutcome, planRunResumable, planRunStatus, readLegacyPlanLaunches, withPlanLaunch } from "./plan-launches";
import { createPlanLaunchesStore, type PlanLaunchesClient } from "../app/plan-launches.svelte";
import type { PlanLaunch, PlanLaunches, PlanLaunchesRequest } from "../../../acp/src/acp/plan-launches-contract";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

/** In-memory ACP backend with the same semantics as the project-file store. */
function backend(now: () => number = () => 100) {
  const files = new Map<string, Record<string, PlanLaunch>>();
  const requests: PlanLaunchesRequest[] = [];
  const client: PlanLaunchesClient = {
    async planLaunches(request) {
      requests.push(request);
      const current = { ...(files.get(request.cwd) ?? {}) };
      if (request.action === "record") current[request.sessionId] = { path: request.path, launchedAt: now() };
      if (request.action === "settle" && current[request.sessionId]) {
        current[request.sessionId] = { ...current[request.sessionId]!, outcome: request.outcome, settledAt: now() };
      }
      if (request.action === "import") for (const [id, launch] of Object.entries(request.launches)) current[id] ??= launch;
      files.set(request.cwd, current);
      return current;
    },
  };
  return { client, files, requests };
}

async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("plan runs", () => {
  it("lists sessions launched from one plan, newest first", async () => {
    let t = 0;
    const { client } = backend(() => ++t);
    const store = createPlanLaunchesStore({ client: () => client, now: () => ++t });
    await store.load("/a");
    store.record("/a", "s1", ".pi/plans/x.md");
    store.record("/a", "s2", ".pi/plans/y.md");
    store.record("/a", "s3", ".pi/plans/x.md");
    await flush();
    expect(store.sessionsFor("/a", ".pi/plans/x.md").map((run) => run.sessionId)).toEqual(["s3", "s1"]);
    expect(store.sessionsFor("/b", ".pi/plans/x.md")).toEqual([]);
  });
});

describe("legacy plan launches", () => {
  it("reads valid legacy entries and forgets them", () => {
    const persisted = storage();
    expect(readLegacyPlanLaunches("/a", persisted)).toBeUndefined();
    persisted.setItem(planLaunchesKey("/c"), JSON.stringify({
      ok: { path: ".pi/plans/y.md", launchedAt: 2 },
      escape: { path: ".pi/plans/../secret.md", launchedAt: 3 },
      notPlan: { path: "README.md", launchedAt: 4 },
      badTime: { path: ".pi/plans/z.md", launchedAt: "now" },
      badOutcome: { path: ".pi/plans/x.md", launchedAt: 5, outcome: "exploded", settledAt: 6 },
      junk: 5,
    }));
    expect(readLegacyPlanLaunches("/c", persisted)).toEqual({
      ok: { path: ".pi/plans/y.md", launchedAt: 2 },
      badOutcome: { path: ".pi/plans/x.md", launchedAt: 5 },
    });
    persisted.setItem(planLaunchesKey("/d"), "{not json");
    expect(readLegacyPlanLaunches("/d", persisted)).toEqual({});
    expect(readLegacyPlanLaunches("", persisted)).toBeUndefined();
    forgetLegacyPlanLaunches("/c", persisted);
    expect(persisted.values.has(planLaunchesKey("/c"))).toBe(false);
  });

  it("keeps only the newest launches", () => {
    let launches: PlanLaunches = {};
    for (let index = 0; index < PLAN_LAUNCH_LIMIT + 5; index += 1) launches = withPlanLaunch(launches, `s${index}`, ".pi/plans/x.md", index);
    expect(Object.keys(launches)).toHaveLength(PLAN_LAUNCH_LIMIT);
    expect(launches).not.toHaveProperty("s0");
    expect(launches).toHaveProperty(`s${PLAN_LAUNCH_LIMIT + 4}`);
  });

  it("store imports legacy records once and removes them only after ACP acknowledges", async () => {
    const persisted = storage();
    persisted.setItem(planLaunchesKey("/a"), JSON.stringify({ s1: { path: ".pi/plans/x.md", launchedAt: 1 } }));
    const failing: PlanLaunchesClient = { planLaunches: vi.fn(async () => { throw new Error("offline"); }) };
    const report = vi.fn();
    await createPlanLaunchesStore({ client: () => failing, storage: persisted, report }).load("/a");
    expect(report).toHaveBeenCalledWith("plan-launches:load-failed", expect.any(Error));
    expect(persisted.values.has(planLaunchesKey("/a"))).toBe(true);

    const { client, requests } = backend();
    const store = createPlanLaunchesStore({ client: () => client, storage: persisted });
    await store.load("/a");
    expect(requests).toEqual([{ cwd: "/a", action: "import", launches: { s1: { path: ".pi/plans/x.md", launchedAt: 1 } } }]);
    expect(persisted.values.has(planLaunchesKey("/a"))).toBe(false);
    expect(store.get("/a", "s1")).toBe(".pi/plans/x.md");
    // A reopened store reads the ACP-owned state with a plain list.
    const reopened = createPlanLaunchesStore({ client: () => client, storage: persisted });
    await reopened.load("/a");
    expect(requests.at(-1)).toEqual({ cwd: "/a", action: "list" });
    expect(reopened.get("/a", "s1")).toBe(".pi/plans/x.md");
  });
});

describe("plan launches store", () => {
  it("records through ACP, survives a reopen and ignores non-plan paths", async () => {
    const { client, requests } = backend(() => 10);
    const store = createPlanLaunchesStore({ client: () => client, now: () => 10 });
    store.record("/a", "s1", ".pi/plans/rollout.md");
    store.record("/a", "s2", "README.md");
    expect(store.get("/a", "s1")).toBe(".pi/plans/rollout.md");
    expect(store.get("/a", "s2")).toBeUndefined();
    expect(store.get("/b", "s1")).toBeUndefined();
    expect(store.get("/a", null)).toBeUndefined();
    await flush();
    expect(requests.filter((request) => request.action === "record")).toEqual([
      { cwd: "/a", action: "record", sessionId: "s1", path: ".pi/plans/rollout.md" },
    ]);
    const reopened = createPlanLaunchesStore({ client: () => client });
    await reopened.load("/a");
    expect(reopened.get("/a", "s1")).toBe(".pi/plans/rollout.md");
  });

  it("keeps a launch live until it settles and ignores unknown sessions", async () => {
    let t = 0;
    const { client, requests } = backend(() => ++t);
    const store = createPlanLaunchesStore({ client: () => client, now: () => t });
    await store.load("/a");
    store.record("/a", "s1", ".pi/plans/x.md");
    await flush();
    expect(store.sessionsFor("/a", ".pi/plans/x.md")).toEqual([{ sessionId: "s1", launchedAt: 1, live: true }]);
    store.settle("s1", "cancelled");
    await flush();
    expect(store.launch("/a", "s1")).toEqual({ path: ".pi/plans/x.md", sessionId: "s1", launchedAt: 1, outcome: "cancelled", live: false });
    store.settle("s1", "completed", "/a");
    await flush();
    expect(store.launch("/a", "s1")?.outcome).toBe("completed");
    store.record("/a", "s2", ".pi/plans/x.md");
    store.started("s2");
    expect(store.launch("/a", "s2")?.live).toBe(false);
    const before = requests.length;
    store.settle("ordinary", "failed");
    expect(requests).toHaveLength(before + 0);
    expect(store.launch("/a", "ordinary")).toBeUndefined();
  });

  it("a stale response never overwrites a later mutation", async () => {
    const resolvers: ((value: PlanLaunches) => void)[] = [];
    const client: PlanLaunchesClient = { planLaunches: () => new Promise((resolve) => resolvers.push(resolve)) };
    const store = createPlanLaunchesStore({ client: () => client, now: () => 1 });
    const loading = store.load("/a");
    store.record("/a", "s1", ".pi/plans/x.md");
    // The record response arrives first, then the older list response.
    resolvers[1]!({ s1: { path: ".pi/plans/x.md", launchedAt: 1 } });
    await flush();
    resolvers[0]!({});
    await loading;
    expect(store.get("/a", "s1")).toBe(".pi/plans/x.md");
  });

  it("reports offline mutations and drops responses after dispose", async () => {
    const report = vi.fn();
    let current: PlanLaunchesClient | null = null;
    const store = createPlanLaunchesStore({ client: () => current, report, now: () => 1 });
    store.record("/a", "s1", ".pi/plans/x.md");
    expect(report).toHaveBeenCalledWith("plan-launches:offline", expect.any(Error));
    let resolve!: (value: PlanLaunches) => void;
    current = { planLaunches: () => new Promise((done) => { resolve = done; }) };
    const loading = store.load("/a");
    store.dispose();
    resolve({});
    await loading;
    expect(store.get("/a", "s1")).toBe(".pi/plans/x.md");
  });
});

describe("plan run status", () => {
  it("maps prompt stop reasons to outcomes", () => {
    expect(planLaunchOutcome("end_turn")).toBe("completed");
    expect(planLaunchOutcome("cancelled")).toBe("cancelled");
    expect(planLaunchOutcome("max_tokens")).toBe("failed");
    expect(planLaunchOutcome("refusal")).toBe("failed");
  });

  it("derives running/done/failed/interrupted from outcome, activity and saved checklist", () => {
    const open = { completed: 2, total: 5 };
    const finished = { completed: 5, total: 5 };
    expect(planRunStatus({ outcome: "failed" }, true, open)).toBe("running");
    expect(planRunStatus({ outcome: "failed" }, false, finished)).toBe("failed");
    expect(planRunStatus({ outcome: "cancelled" }, false, finished)).toBe("interrupted");
    expect(planRunStatus({ outcome: "completed" }, false, open)).toBe("interrupted");
    expect(planRunStatus({ outcome: "completed" }, false, finished)).toBe("done");
    expect(planRunStatus({ outcome: "completed" }, false, null)).toBe("done");
    expect(planRunStatus({ outcome: "completed" }, false, { completed: 0, total: 0 })).toBe("done");
    expect(planRunStatus({}, false, open)).toBe("interrupted");
    expect(planRunStatus({}, false, finished)).toBe("done");
    expect(["running", "done", "failed", "interrupted"].map((status) => planRunResumable(status as never)))
      .toEqual([false, false, true, true]);
  });
});
