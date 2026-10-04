import { describe, expect, it } from "vitest";
import { sidebarIndicatorActionGroups } from "./sidebar-indicator-actions";
import { sidebarIndicatorReasons, sidebarIndicators } from "./sidebar-indicators";
import type { SidebarIndicatorInputs, SidebarIndicatorReasonId } from "./sidebar-indicator-types";

const base: SidebarIndicatorInputs = {
  service: { unseenScriptFailureIds: [], unseenIdxFailureIds: [], idxOverview: {
    available: true, initialized: true, knowledgeDirty: false, indexStale: false, errors: [], rawStatus: "",
  } }, taskStorageError: false, activeTaskId: null, registrySnapshot: undefined,
};

describe("sidebar indicator reason actions", () => {
  it("has no menu in a healthy state and never infers review from counters", () => {
    expect(sidebarIndicatorReasons(base)).toEqual({});
    expect(sidebarIndicatorActionGroups()).toEqual([]);
  });

  it("offers AI review only for dirty knowledge, alongside independent stale/error reasons", () => {
    const input = { ...base, service: { ...base.service, idxPollError: "timeout", idxOverview: {
      ...base.service.idxOverview!, knowledgeDirty: true, indexStale: true,
    } } };
    const groups = sidebarIndicatorActionGroups(sidebarIndicatorReasons(input).idx);
    expect(groups.map((group) => group.id)).toEqual(["idx.error", "idx.dirty", "idx.stale"]);
    expect(groups.flatMap((group) => group.actions.map((action) => action.id)))
      .toEqual(["idx.inspect", "idx.review", "idx.maintenance"]);
    expect(sidebarIndicators(input).idx).toEqual({ tone: "error", reason: "timeout" });
    expect(sidebarIndicatorActionGroups(sidebarIndicatorReasons(base).idx)).toEqual([]);
  });

  it("does not hide lower-priority Git reasons behind a conflict dot", () => {
    const input = { ...base, service: { ...base.service, poll: {
      project: {}, git: { available: true, dirty: true, conflicted: true, detached: true, ahead: 2, behind: 3 },
      registry: { localChanges: false, stable: true }, scripts: { runningIds: [], failedIds: [] },
      idx: { runningIds: [], failedIds: [] }, settings: { errors: [] }, checkedAtMs: 1,
    }, gitRemote: { hasUpdates: true, checkedAtMs: 1 } } };
    expect(sidebarIndicators(input).git?.tone).toBe("error");
    expect(sidebarIndicatorActionGroups(sidebarIndicatorReasons(input).git).map((group) => group.id))
      .toEqual(["git.conflicts", "git.detached", "git.remote", "git.dirty", "git.ahead", "git.behind"]);
  });

  it("merges duplicate error reports and disables current ineligible commands", () => {
    const reasons = sidebarIndicatorReasons({ ...base, taskStorageError: true, taskStorageSaveError: "save failed",
      activeTaskId: "running", hasPlannedTasks: true }).tasks;
    const groups = sidebarIndicatorActionGroups(reasons, { "tasks.reload": false, "tasks.running": false });
    expect(groups.map((group) => group.id)).toEqual(["tasks.error", "tasks.running", "tasks.planned"]);
    expect(groups[0]?.reason).toContain("save failed");
    expect(groups[0]?.actions[0]?.disabled).toBe(true);
    expect(groups[1]?.actions[0]?.disabled).toBe(true);
    expect(groups[2]?.actions[0]?.disabled).toBe(false);
  });

  it.each([
    ["project.error", "project.retry"], ["tasks.error", "tasks.reload"], ["tasks.running", "tasks.running"],
    ["tasks.planned", "tasks.show"], ["git.error", "git.refresh"], ["git.ci-failed", "git.ci"],
    ["git.conflicts", "git.conflicts"], ["git.detached", "git.branch"], ["git.remote", "git.fetch"],
    ["git.dirty", "git.changes"], ["git.ahead", "git.push"], ["git.behind", "git.incoming"],
    ["registry.error", "registry.refresh"], ["registry.issue", "registry.review"],
    ["registry.attention", "registry.review"], ["registry.syncing", "registry.sync"],
    ["registry.pending", "registry.sync"], ["registry.local", "registry.review"],
    ["scripts.error", "scripts.inspect"], ["scripts.failed", "scripts.inspect"], ["scripts.running", "scripts.running"],
    ["idx.error", "idx.inspect"], ["idx.failed", "idx.inspect"], ["idx.unavailable", "idx.inspect"],
    ["idx.dirty", "idx.review"], ["idx.stale", "idx.maintenance"], ["idx.running", "idx.running"],
    ["settings.error", "settings.inspect"],
  ])("maps %s to its cause-specific command", (id, action) => {
    expect(sidebarIndicatorActionGroups([{ id: id as SidebarIndicatorReasonId, tone: "error", reason: "copy may change" }])[0]?.actions[0]?.id)
      .toBe(action);
  });
});
