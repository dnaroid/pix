import type { IdxOverview } from "./idx";
import type { GitCiSnapshot } from "./git-ci";
import type { RegistryProjectArtifact, RegistrySnapshot } from "./registry";
import type { RegistryBackgroundSyncState } from "./registry-background-sync";

export type SidebarIndicatorTab =
  | "project"
  | "tasks"
  | "git"
  | "registry"
  | "scripts"
  | "idx"
  | "settings";

export type SidebarIndicatorTone = "info" | "warning" | "error";

export interface SidebarIndicator {
  readonly tone: SidebarIndicatorTone;
  readonly reason: string;
  readonly animated?: boolean;
}

/** Stable identity, independent of tooltip copy, for reason-specific commands. */
export type SidebarIndicatorReasonId =
  | "project.error"
  | "tasks.error" | "tasks.running" | "tasks.planned"
  | "git.error" | "git.ci-failed" | "git.conflicts" | "git.detached"
  | "git.remote" | "git.dirty" | "git.ahead" | "git.behind"
  | "registry.error" | "registry.issue" | "registry.attention"
  | "registry.syncing" | "registry.pending" | "registry.local"
  | "scripts.error" | "scripts.failed" | "scripts.running"
  | "idx.error" | "idx.failed" | "idx.unavailable" | "idx.dirty" | "idx.stale" | "idx.running"
  | "settings.error";

export interface SidebarIndicatorReason extends SidebarIndicator {
  readonly id: SidebarIndicatorReasonId;
}

export type SidebarIndicatorReasonMap = Readonly<Partial<Record<SidebarIndicatorTab, readonly SidebarIndicatorReason[]>>>;

export interface RuntimeIndicatorPoll {
  readonly runningIds: readonly string[];
  readonly failedIds: readonly string[];
  readonly error?: string;
}

export interface WorkspaceSidebarIndicatorPoll {
  readonly project: {
    readonly error?: string;
  };
  readonly git: {
    readonly available: boolean;
    readonly dirty: boolean;
    readonly conflicted: boolean;
    readonly detached: boolean;
    readonly ahead: number;
    readonly behind: number;
    readonly error?: string;
  };
  readonly registry: {
    readonly localChanges: boolean;
    readonly projectChanges?: readonly RegistryProjectArtifact[];
    readonly stable: boolean;
    readonly error?: string;
  };
  readonly scripts: RuntimeIndicatorPoll;
  readonly idx: RuntimeIndicatorPoll;
  readonly settings: {
    readonly errors: readonly string[];
  };
  readonly checkedAtMs: number;
}

export interface SidebarGitRemoteUpdateProbe {
  readonly hasUpdates: boolean;
  readonly checkedAtMs: number;
}

export interface SidebarIndicatorServiceState {
  readonly idxOperationHandoffPending?: boolean;
  readonly poll?: WorkspaceSidebarIndicatorPoll;
  readonly gitRemote?: SidebarGitRemoteUpdateProbe;
  readonly idxOverview?: IdxOverview;
  readonly idxPollError?: string;
  readonly unseenScriptFailureIds: readonly string[];
  readonly unseenIdxFailureIds: readonly string[];
}

export interface SidebarIndicatorInputs {
  readonly service: SidebarIndicatorServiceState;
  readonly projectPanelError?: string | null;
  readonly taskStorageError: boolean;
  readonly taskStorageSaveError?: string | null;
  readonly activeTaskId?: string | null;
  readonly hasPlannedTasks?: boolean;
  readonly gitCiSnapshot?: GitCiSnapshot;
  readonly registrySnapshot?: RegistrySnapshot;
  readonly registryBackgroundSync?: RegistryBackgroundSyncState;
  readonly settingsPanelError?: string | null;
}

export type SidebarIndicatorMap = Readonly<Partial<Record<SidebarIndicatorTab, SidebarIndicator>>>;
