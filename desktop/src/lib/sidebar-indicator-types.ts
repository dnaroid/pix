import type { IdxOverview } from "./idx";
import type { RegistrySnapshot } from "./registry";

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
}

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

export interface SidebarIndicatorServiceState {
  readonly poll?: WorkspaceSidebarIndicatorPoll;
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
  readonly registrySnapshot?: RegistrySnapshot;
  readonly settingsPanelError?: string | null;
}

export type SidebarIndicatorMap = Readonly<Partial<Record<SidebarIndicatorTab, SidebarIndicator>>>;
