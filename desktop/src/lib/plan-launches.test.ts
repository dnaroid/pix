import { describe, expect, it } from "vitest";
import { loadPlanLaunches, PLAN_LAUNCH_LIMIT, planLaunchesKey, planLaunchOutcome, planRunResumable, planRunStatus, savePlanLaunches, withPlanLaunch } from "./plan-launches";
import { createPlanLaunchesStore } from "../app/plan-launches.svelte";

function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe("plan runs", () => {
  it("lists sessions launched from one plan, newest first", () => {
    let t = 0;
    const store = createPlanLaunchesStore(storage(), () => ++t);
    store.record("/a", "s1", ".pi/plans/x.md");
    store.record("/a", "s2", ".pi/plans/y.md");
    store.record("/a", "s3", ".pi/plans/x.md");
    expect(store.sessionsFor("/a", ".pi/plans/x.md").map((run) => run.sessionId)).toEqual(["s3", "s1"]);
    expect(store.sessionsFor("/b", ".pi/plans/x.md")).toEqual([]);
  });
});

describe("persisted plan launches", () => {
  it("round-trips per workspace and drops invalid entries", () => {
    const persisted = storage();
    savePlanLaunches("/a", { s1: { path: ".pi/plans/x.md", launchedAt: 1 } }, persisted);
    expect(loadPlanLaunches("/a", persisted)).toEqual({ s1: { path: ".pi/plans/x.md", launchedAt: 1 } });
    expect(loadPlanLaunches("/b", persisted)).toEqual({});
    persisted.setItem(planLaunchesKey("/c"), JSON.stringify({
      ok: { path: ".pi/plans/y.md", launchedAt: 2 },
      escape: { path: ".pi/plans/../secret.md", launchedAt: 3 },
      notPlan: { path: "README.md", launchedAt: 4 },
      badTime: { path: ".pi/plans/z.md", launchedAt: "now" },
      junk: 5,
    }));
    expect(Object.keys(loadPlanLaunches("/c", persisted))).toEqual(["ok"]);
    persisted.setItem(planLaunchesKey("/d"), "{not json");
    expect(loadPlanLaunches("/d", persisted)).toEqual({});
    expect(loadPlanLaunches("", persisted)).toEqual({});
  });

  it("keeps only the newest launches", () => {
    let launches = {};
    for (let index = 0; index < PLAN_LAUNCH_LIMIT + 5; index += 1) launches = withPlanLaunch(launches, `s${index}`, ".pi/plans/x.md", index);
    expect(Object.keys(launches)).toHaveLength(PLAN_LAUNCH_LIMIT);
    expect(launches).not.toHaveProperty("s0");
    expect(launches).toHaveProperty(`s${PLAN_LAUNCH_LIMIT + 4}`);
  });

  it("store records, survives a reopen and ignores non-plan paths", () => {
    const persisted = storage();
    const store = createPlanLaunchesStore(persisted, () => 10);
    store.record("/a", "s1", ".pi/plans/rollout.md");
    store.record("/a", "s2", "README.md");
    expect(store.get("/a", "s1")).toBe(".pi/plans/rollout.md");
    expect(store.get("/a", "s2")).toBeUndefined();
    expect(store.get("/b", "s1")).toBeUndefined();
    expect(store.get("/a", null)).toBeUndefined();
    expect(createPlanLaunchesStore(persisted).get("/a", "s1")).toBe(".pi/plans/rollout.md");
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
    // No outcome (app quit mid-run / legacy record): the saved checklist decides.
    expect(planRunStatus({}, false, open)).toBe("interrupted");
    expect(planRunStatus({}, false, finished)).toBe("done");
    expect(["running", "done", "failed", "interrupted"].map((status) => planRunResumable(status as never)))
      .toEqual([false, false, true, true]);
  });

  it("persists outcomes and drops malformed ones without losing the launch", () => {
    const persisted = storage();
    persisted.setItem(planLaunchesKey("/a"), JSON.stringify({
      ok: { path: ".pi/plans/x.md", launchedAt: 1, outcome: "failed", settledAt: 2 },
      badOutcome: { path: ".pi/plans/x.md", launchedAt: 3, outcome: "exploded", settledAt: 4 },
      noTime: { path: ".pi/plans/x.md", launchedAt: 5, outcome: "completed" },
    }));
    expect(loadPlanLaunches("/a", persisted)).toEqual({
      ok: { path: ".pi/plans/x.md", launchedAt: 1, outcome: "failed", settledAt: 2 },
      badOutcome: { path: ".pi/plans/x.md", launchedAt: 3 },
      noTime: { path: ".pi/plans/x.md", launchedAt: 5 },
    });
  });

  it("store keeps a launch live until it settles and ignores unknown sessions", () => {
    const persisted = storage();
    let t = 0;
    const store = createPlanLaunchesStore(persisted, () => ++t);
    store.record("/a", "s1", ".pi/plans/x.md");
    expect(store.sessionsFor("/a", ".pi/plans/x.md")).toEqual([{ sessionId: "s1", launchedAt: 1, live: true }]);
    store.settle("s1", "cancelled");
    expect(store.launch("/a", "s1")).toEqual({ path: ".pi/plans/x.md", sessionId: "s1", launchedAt: 1, outcome: "cancelled", live: false });
    // A later prompt in the same session replaces the outcome.
    store.settle("s1", "completed", "/a");
    expect(store.launch("/a", "s1")?.outcome).toBe("completed");
    store.record("/a", "s2", ".pi/plans/x.md");
    store.started("s2");
    expect(store.launch("/a", "s2")?.live).toBe(false);
    store.settle("ordinary", "failed");
    expect(store.launch("/a", "ordinary")).toBeUndefined();
    const reopened = createPlanLaunchesStore(persisted);
    expect(reopened.launch("/a", "s1")).toMatchObject({ outcome: "completed", live: false });
  });
});
