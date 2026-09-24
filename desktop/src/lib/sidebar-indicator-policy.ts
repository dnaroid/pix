import { registryHasAttention } from "./registry";
import type {
  SidebarIndicator,
  SidebarIndicatorInputs,
  SidebarIndicatorMap,
  SidebarIndicatorTab,
  SidebarIndicatorTone,
  WorkspaceSidebarIndicatorPoll,
} from "./sidebar-indicator-types";

const TONE_PRIORITY: Record<SidebarIndicatorTone, number> = {
  info: 1,
  warning: 2,
  error: 3,
};

/** Build all Activity Bar signals from one backend poll plus live UI/session state. */
export function sidebarIndicators(inputs: SidebarIndicatorInputs): SidebarIndicatorMap {
  const { service } = inputs;
  const poll = service.poll;
  const indicators: Partial<Record<SidebarIndicatorTab, SidebarIndicator>> = {};

  indicators.project = strongestIndicator(
    errorIndicator(inputs.projectPanelError),
    errorIndicator(poll?.project.error),
  );

  indicators.tasks = strongestIndicator(
    errorIndicator(inputs.taskStorageSaveError),
    inputs.taskStorageError ? { tone: "error", reason: "Project tasks could not be read or saved" } : undefined,
    inputs.activeTaskId ? { tone: "info", reason: "A project task is running" } : undefined,
  );

  const git = poll?.git;
  indicators.git = strongestIndicator(
    errorIndicator(git?.error),
    git?.conflicted ? { tone: "error", reason: "Git has unresolved conflicts" } : undefined,
    git?.detached ? { tone: "warning", reason: "Git is on a detached HEAD" } : undefined,
    git?.dirty ? { tone: "info", reason: "Working tree has changes" } : undefined,
    (git?.ahead ?? 0) > 0 ? { tone: "info", reason: `Branch has ${git?.ahead} unpushed commit${git?.ahead === 1 ? "" : "s"}` } : undefined,
    (git?.behind ?? 0) > 0 ? { tone: "info", reason: `Branch is behind upstream by ${git?.behind}` } : undefined,
  );

  const registrySync = inputs.registryBackgroundSync;
  const registrySyncActive = inputs.registrySnapshot?.configured === true
    && (registrySync?.phase === "syncing" || registrySync?.phase === "pending");
  indicators.registry = strongestIndicator(
    errorIndicator(inputs.registrySnapshot?.error),
    errorIndicator(poll?.registry.error),
    errorIndicator(inputs.registrySnapshot?.configured === true && registrySync?.phase === "error" ? registrySync.error : undefined),
    inputs.registrySnapshot?.projectIssue
      ? { tone: "warning", reason: inputs.registrySnapshot.projectIssue }
      : undefined,
    registryHasAttention(inputs.registrySnapshot)
      ? { tone: "warning", reason: "Registry has resources that need attention" }
      : undefined,
    registrySyncActive && registrySync?.phase === "syncing"
      ? { tone: "info", reason: "Project changes are syncing in the background", animated: true }
      : undefined,
    registrySyncActive && registrySync?.phase === "pending"
      ? { tone: "info", reason: "Project changes are waiting to sync" }
      : undefined,
    !registrySyncActive && poll?.registry.localChanges
      ? { tone: "warning", reason: "Local registry resources need sync" }
      : undefined,
  );

  indicators.scripts = strongestIndicator(
    errorIndicator(poll?.scripts.error),
    service.unseenScriptFailureIds.length > 0
      ? { tone: "error", reason: "A terminal exited with an error" }
      : undefined,
    (poll?.scripts.runningIds.length ?? 0) > 0
      ? {
          tone: "info",
          reason: `${poll?.scripts.runningIds.length} terminal${poll?.scripts.runningIds.length === 1 ? " is" : "s are"} running`,
        }
      : undefined,
  );

  const idxOverview = service.idxOverview;
  indicators.idx = strongestIndicator(
    errorIndicator(poll?.idx.error),
    service.unseenIdxFailureIds.length > 0
      ? { tone: "error", reason: "An IDX maintenance operation failed" }
      : undefined,
    errorIndicator(service.idxPollError),
    idxOverview?.initialized && idxOverview.available === false
      ? { tone: "error", reason: "IDX is unavailable for this indexed project" }
      : undefined,
    (idxOverview?.errors.length ?? 0) > 0
      ? { tone: "error", reason: idxOverview?.errors[0] ?? "IDX status check failed" }
      : undefined,
    (poll?.idx.runningIds.length ?? 0) > 0
      ? { tone: "info", reason: "IDX maintenance is running" }
      : undefined,
  );

  indicators.settings = strongestIndicator(
    errorIndicator(inputs.settingsPanelError),
    poll?.settings.errors[0]
      ? { tone: "error", reason: poll.settings.errors[0] }
      : undefined,
  );

  return Object.fromEntries(Object.entries(indicators).filter(([, value]) => value !== undefined));
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

function errorIndicator(reason: string | null | undefined): SidebarIndicator | undefined {
  return reason?.trim() ? { tone: "error", reason: reason.trim() } : undefined;
}
