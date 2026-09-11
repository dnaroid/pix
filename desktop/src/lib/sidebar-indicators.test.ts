import { describe, expect, it } from "vitest";
import {
  mergeStableRegistryIndicatorPoll,
  runtimeOutputNeedsRefresh,
  sidebarIndicators,
  strongestIndicator,
  type SidebarIndicatorInputs,
  type SidebarIndicatorServiceState,
  type WorkspaceSidebarIndicatorPoll,
} from "./sidebar-indicators";

function poll(overrides: Partial<WorkspaceSidebarIndicatorPoll> = {}): WorkspaceSidebarIndicatorPoll {
  return {
    project: {},
    git: { available: true, dirty: false, conflicted: false, detached: false, ahead: 0, behind: 0 },
    registry: { localChanges: false, stable: true },
    scripts: { runningIds: [], failedIds: [] },
    idx: { runningIds: [], failedIds: [] },
    settings: { errors: [] },
    checkedAtMs: 1,
    ...overrides,
  };
}

function inputs(service: SidebarIndicatorServiceState): SidebarIndicatorInputs {
  return {
    service,
    taskStorageError: false,
    activeTaskId: null,
    registrySnapshot: undefined,
  };
}

describe("sidebar indicators", () => {
  it("uses one semantic Git dot and lets conflicts outrank ordinary changes", () => {
    const changed = sidebarIndicators(inputs({
      poll: poll({
        git: { available: true, dirty: true, conflicted: false, detached: false, ahead: 3, behind: 0 },
      }),
      unseenScriptFailureIds: [],
      unseenIdxFailureIds: [],
    }));
    expect(changed.git).toEqual({ tone: "info", reason: "Working tree has changes" });

    const conflicted = sidebarIndicators(inputs({
      poll: poll({
        git: { available: true, dirty: true, conflicted: true, detached: false, ahead: 3, behind: 0 },
      }),
      unseenScriptFailureIds: [],
      unseenIdxFailureIds: [],
    }));
    expect(conflicted.git?.tone).toBe("error");
  });

  it("prefers unseen terminal failures over running activity", () => {
    const result = sidebarIndicators(inputs({
      poll: poll({ scripts: { runningIds: ["term-1"], failedIds: ["term-2"] } }),
      unseenScriptFailureIds: ["term-2"],
      unseenIdxFailureIds: [],
    }));
    expect(result.scripts).toEqual({ tone: "error", reason: "A terminal exited with an error" });
  });

  it("covers task activity, registry review, and IDX knowledge maintenance", () => {
    const result = sidebarIndicators({
      ...inputs({
        poll: poll(),
        idxOverview: {
          available: true,
          initialized: true,
          wikiStatus: {
            fields: {
              primarySpecs: "10 (10 current/proposed)",
              fresh: "9",
              needsReview: "1",
            },
            raw: "",
          },
          rawStatus: "",
          errors: [],
        },
        unseenScriptFailureIds: [],
        unseenIdxFailureIds: [],
      }),
      activeTaskId: "task-1",
      registrySnapshot: {
        version: 1,
        configured: true,
        branch: "main",
        checkedAt: "2026-09-10T12:00:00Z",
        items: [{
          id: "skill:review",
          type: "skill",
          name: "review",
          status: "update-available",
          statusLabel: "Update available",
          icon: "package",
          local: true,
          remote: true,
          actions: ["update"],
        }],
      },
    });

    expect(result.tasks).toEqual({ tone: "info", reason: "A project task is running" });
    expect(result.registry?.tone).toBe("warning");
    expect(result.idx).toEqual({ tone: "warning", reason: "Knowledge base needs maintenance" });
  });

  it("shows the registry indicator for locally changed resources", () => {
    const result = sidebarIndicators(inputs({
      poll: poll({ registry: { localChanges: true, stable: true } }),
      unseenScriptFailureIds: [],
      unseenIdxFailureIds: [],
    }));

    expect(result.registry).toEqual({
      tone: "warning",
      reason: "Local registry resources need sync",
    });
  });

  it("keeps the last registry signal when a filesystem scan races a write", () => {
    const previous = poll({ registry: { localChanges: true, stable: true } });
    const unstable = poll({ registry: { localChanges: false, stable: false }, checkedAtMs: 2 });
    const merged = mergeStableRegistryIndicatorPoll(previous, unstable);

    expect(merged.registry).toEqual(previous.registry);
    expect(merged.checkedAtMs).toBe(unstable.checkedAtMs);
  });

  it("surfaces project and config health errors without creating normal-state dots", () => {
    const healthy = sidebarIndicators(inputs({
      poll: poll(),
      unseenScriptFailureIds: [],
      unseenIdxFailureIds: [],
    }));
    expect(healthy.project).toBeUndefined();
    expect(healthy.settings).toBeUndefined();

    const broken = sidebarIndicators(inputs({
      poll: poll({
        project: { error: "workspace unreadable" },
        settings: { errors: ["pix.jsonc contains invalid JSONC"] },
      }),
      unseenScriptFailureIds: [],
      unseenIdxFailureIds: [],
    }));
    expect(broken.project?.tone).toBe("error");
    expect(broken.settings?.tone).toBe("error");
  });

  it("orders error above warning above info", () => {
    expect(strongestIndicator(
      { tone: "info", reason: "running" },
      { tone: "warning", reason: "review" },
      { tone: "error", reason: "failed" },
    )).toEqual({ tone: "error", reason: "failed" });
  });

  it("does not repoll on every output chunk after a runtime is already known", () => {
    expect(runtimeOutputNeedsRefresh(undefined, "run-1")).toBe(true);
    expect(runtimeOutputNeedsRefresh([], "run-1")).toBe(true);
    expect(runtimeOutputNeedsRefresh(["run-1"], "run-1")).toBe(false);
    expect(runtimeOutputNeedsRefresh(["run-2"], "run-1")).toBe(true);
  });

});
