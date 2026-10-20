import { describe, expect, it } from "vitest";
import { sidebarIndicatorActionGroups } from "./sidebar-indicator-actions";
import { sidebarIndicatorReasons, sidebarIndicators } from "./sidebar-indicators";
import type { SidebarIndicatorInputs, SidebarIndicatorReasonId } from "./sidebar-indicator-types";

const base: SidebarIndicatorInputs = {
  service: { unseenScriptFailureIds: [] }, taskStorageError: false, activeTaskId: null, registrySnapshot: undefined,
};

describe("sidebar indicator reason actions", () => {
  it("offers a guarded bulk project sync alongside review for local Registry changes", () => {
    const groups = sidebarIndicatorActionGroups([{ id: "registry.local", tone: "warning", reason: "Local changes" }], {
      "registry.push-project-resources": false,
    });
    expect(groups[0]!.actions).toEqual([
      { id: "registry.review", label: "Review resource changes…", disabled: false },
      { id: "registry.push-project-resources", label: "Sync project changes to Registry", disabled: true },
    ]);
  });
  it("adds combined staging, AI commit and push only to dirty Git, with a capability guard", () => {
    const reasons = [{ id: "git.dirty" as const, tone: "info" as const, reason: "Changes" }];
    const actions = sidebarIndicatorActionGroups(reasons, { "git.commit-push": false }, ["origin"])[0]!.actions;
    expect(actions.map((action) => action.id)).toEqual(["git.changes", "git.commit-push"]);
    expect(actions[1]).toMatchObject({ label: "Stage all, AI commit & push", disabled: true });
    expect(sidebarIndicatorActionGroups([{ id: "git.ahead", tone: "info", reason: "Ahead" }], {}, ["origin"])[0]!.actions.map((action) => action.id)).toEqual(["git.push"]);
  });
  it.each([undefined, []])("omits push commands without confirmed remotes (%s), keeping local review", (remotes) => {
    const groups = sidebarIndicatorActionGroups([
      { id: "git.dirty", tone: "info", reason: "Changes" },
      { id: "git.ahead", tone: "info", reason: "Ahead" },
    ], { "git.commit-push": true, "git.push": true }, remotes);
    expect(groups[0]!.actions.map((action) => action.id)).toEqual(["git.changes"]);
    expect(groups[1]!.actions).toEqual([]);
  });
  it("has no menu in a healthy state and never infers review from counters", () => {
    expect(sidebarIndicatorReasons(base)).toEqual({});
    expect(sidebarIndicatorActionGroups()).toEqual([]);
  });

  it("does not hide lower-priority Git reasons behind a conflict dot", () => {
    const input = { ...base, service: { ...base.service, poll: {
      project: {}, git: { available: true, dirty: true, conflicted: true, detached: true, ahead: 2, behind: 3 },
      registry: { localChanges: false, stable: true }, scripts: { runningIds: [], failedIds: [] },
      settings: { errors: [] }, checkedAtMs: 1,
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
    ["settings.error", "settings.inspect"],
  ])("maps %s to its cause-specific command", (id, action) => {
    expect(sidebarIndicatorActionGroups([{ id: id as SidebarIndicatorReasonId, tone: "error", reason: "copy may change" }], {}, ["origin"])[0]?.actions[0]?.id)
      .toBe(action);
  });
});
