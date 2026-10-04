import { registryHasAttention } from "./registry";
import type {
  SidebarIndicator,
  SidebarIndicatorInputs,
  SidebarIndicatorMap,
  SidebarIndicatorTab,
  SidebarIndicatorTone,
  SidebarIndicatorReason,
  SidebarIndicatorReasonId,
  SidebarIndicatorReasonMap,
  WorkspaceSidebarIndicatorPoll,
} from "./sidebar-indicator-types";

const TONE_PRIORITY: Record<SidebarIndicatorTone, number> = {
  info: 1,
  warning: 2,
  error: 3,
};

/** Build all Activity Bar signals from one backend poll plus live UI/session state. */
export function sidebarIndicators(inputs: SidebarIndicatorInputs): SidebarIndicatorMap {
  const reasons = sidebarIndicatorReasons(inputs);
  return Object.fromEntries(Object.entries(reasons).map(([tab, candidates]) => {
    const strongest = strongestIndicator(...candidates)!;
    return [tab, {
      tone: strongest.tone,
      reason: strongest.reason,
      ...(strongest.animated ? { animated: true } : {}),
    }];
  }));
}

/** Keep every active reason, even when a higher severity owns the single dot. */
export function sidebarIndicatorReasons(inputs: SidebarIndicatorInputs): SidebarIndicatorReasonMap {
  const { service } = inputs;
  const poll = service.poll;
  const indicators: Partial<Record<SidebarIndicatorTab, SidebarIndicatorReason[]>> = {};

  indicators.project = collectIndicators(
    errorIndicator("project.error", inputs.projectPanelError),
    errorIndicator("project.error", poll?.project.error),
  );

  indicators.tasks = collectIndicators(
    errorIndicator("tasks.error", inputs.taskStorageSaveError),
    inputs.taskStorageError ? { id: "tasks.error", tone: "error", reason: "Project tasks could not be read or saved" } : undefined,
    inputs.activeTaskId ? { id: "tasks.running", tone: "info", reason: "A project task is running" } : undefined,
    inputs.hasPlannedTasks ? { id: "tasks.planned", tone: "info", reason: "Project has planned tasks" } : undefined,
  );

  const git = poll?.git;
  indicators.git = collectIndicators(
    errorIndicator("git.error", git?.error),
    inputs.gitCiSnapshot?.availability === "ready" && inputs.gitCiSnapshot.runs.some((run) => run.status === "failure")
      ? { id: "git.ci-failed", tone: "error", reason: "CI failed for the current Git HEAD" }
      : undefined,
    git?.conflicted ? { id: "git.conflicts", tone: "error", reason: "Git has unresolved conflicts" } : undefined,
    git?.detached ? { id: "git.detached", tone: "warning", reason: "Git is on a detached HEAD" } : undefined,
    service.gitRemote?.hasUpdates ? { id: "git.remote", tone: "info", reason: "Upstream has updates available" } : undefined,
    git?.dirty ? { id: "git.dirty", tone: "info", reason: "Working tree has changes" } : undefined,
    (git?.ahead ?? 0) > 0 ? { id: "git.ahead", tone: "info", reason: `Branch has ${git?.ahead} unpushed commit${git?.ahead === 1 ? "" : "s"}` } : undefined,
    (git?.behind ?? 0) > 0 ? { id: "git.behind", tone: "info", reason: `Branch is behind upstream by ${git?.behind}` } : undefined,
  );

  const registrySync = inputs.registryBackgroundSync;
  const registrySyncActive = inputs.registrySnapshot?.configured === true
    && (registrySync?.phase === "syncing" || registrySync?.phase === "pending");
  indicators.registry = collectIndicators(
    errorIndicator("registry.error", inputs.registrySnapshot?.error),
    errorIndicator("registry.error", poll?.registry.error),
    errorIndicator("registry.error", inputs.registrySnapshot?.configured === true && registrySync?.phase === "error" ? registrySync.error : undefined),
    inputs.registrySnapshot?.projectIssue
      ? { id: "registry.issue", tone: "warning", reason: inputs.registrySnapshot.projectIssue }
      : undefined,
    registryHasAttention(inputs.registrySnapshot)
      ? { id: "registry.attention", tone: "warning", reason: "Registry has resources that need attention" }
      : undefined,
    registrySyncActive && registrySync?.phase === "syncing"
      ? { id: "registry.syncing", tone: "info", reason: "Project changes are syncing in the background", animated: true }
      : undefined,
    registrySyncActive && registrySync?.phase === "pending"
      ? { id: "registry.pending", tone: "info", reason: "Project changes are waiting to sync" }
      : undefined,
    !registrySyncActive && (poll?.registry.localChanges || inputs.registrySnapshot?.items.some((item) =>
      item.type !== "project" && item.local && item.status === "local-changes" && item.publicationScope === "project"))
      ? { id: "registry.local", tone: "warning", reason: "Local registry resources need sync" }
      : undefined,
  );

  indicators.scripts = collectIndicators(
    errorIndicator("scripts.error", poll?.scripts.error),
    service.unseenScriptFailureIds.length > 0
      ? { id: "scripts.failed", tone: "error", reason: "A terminal exited with an error" }
      : undefined,
    (poll?.scripts.runningIds.length ?? 0) > 0
      ? {
          tone: "info",
          id: "scripts.running",
          reason: `${poll?.scripts.runningIds.length} terminal${poll?.scripts.runningIds.length === 1 ? " is" : "s are"} running`,
        }
      : undefined,
  );

  const idxOverview = service.idxOverview;
  indicators.idx = collectIndicators(
    errorIndicator("idx.error", poll?.idx.error),
    service.unseenIdxFailureIds.length > 0
      ? { id: "idx.failed", tone: "error", reason: "An IDX maintenance operation failed" }
      : undefined,
    errorIndicator("idx.error", service.idxPollError),
    idxOverview?.initialized && idxOverview.available === false
      ? { id: "idx.unavailable", tone: "error", reason: "IDX is unavailable for this indexed project" }
      : undefined,
    (idxOverview?.errors.length ?? 0) > 0
      ? { id: "idx.error", tone: "error", reason: idxOverview?.errors[0] ?? "IDX status check failed" }
      : undefined,
    idxOverview?.knowledgeDirty === true
      ? { id: "idx.dirty", tone: "warning", reason: "Knowledge base requires review" }
      : undefined,
    idxOverview?.indexStale === true
      ? { id: "idx.stale", tone: "warning", reason: "Index Git revision differs from HEAD" }
      : undefined,
    (poll?.idx.runningIds.length ?? 0) > 0
      ? { id: "idx.running", tone: "info", reason: "IDX maintenance is running" }
      : undefined,
  );

  indicators.settings = collectIndicators(
    errorIndicator("settings.error", inputs.settingsPanelError),
    poll?.settings.errors[0]
      ? { id: "settings.error", tone: "error", reason: poll.settings.errors[0] }
      : undefined,
  );

  return Object.fromEntries(Object.entries(indicators).filter(([, value]) => value.length > 0));
}

function collectIndicators(...candidates: Array<SidebarIndicatorReason | undefined>): SidebarIndicatorReason[] {
  return candidates.filter((candidate): candidate is SidebarIndicatorReason => candidate !== undefined);
}

export function strongestIndicator(...candidates: Array<SidebarIndicator | undefined>): SidebarIndicator | undefined {
  return candidates.reduce<SidebarIndicator | undefined>((strongest, candidate) => {
    if (!candidate) return strongest;
    if (!strongest || TONE_PRIORITY[candidate.tone] > TONE_PRIORITY[strongest.tone]) return candidate;
    return strongest;
  }, undefined);
}

/** Output chunks only need to invalidate runtime state until the new run is known. */
export function runtimeOutputNeedsRefresh(
  knownRunningIds: readonly string[] | undefined,
  runtimeId: string,
): boolean {
  return !knownRunningIds?.includes(runtimeId);
}

export function mergeStableRegistryIndicatorPoll(
  previous: WorkspaceSidebarIndicatorPoll | undefined,
  next: WorkspaceSidebarIndicatorPoll,
): WorkspaceSidebarIndicatorPoll {
  if (next.registry.stable || !previous) return next;
  return { ...next, registry: previous.registry };
}

function errorIndicator(id: SidebarIndicatorReasonId, reason: string | null | undefined): SidebarIndicatorReason | undefined {
  return reason?.trim() ? { id, tone: "error", reason: reason.trim() } : undefined;
}
