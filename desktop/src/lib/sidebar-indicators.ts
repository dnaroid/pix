import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  IDX_OPERATION_EXIT_EVENT,
  IDX_OPERATION_OUTPUT_EVENT,
  idxKnowledgeNeedsAttention,
  type IdxOperationExitEvent,
  type IdxOperationOutputEvent,
  type IdxOverview,
} from "./idx";
import {
  PACKAGE_TERMINAL_EXIT_EVENT,
  PACKAGE_TERMINAL_OUTPUT_EVENT,
  type PackageTerminalExitEvent,
  type PackageTerminalOutputEvent,
} from "./package-scripts";
import { registryHasAttention, type RegistrySnapshot } from "./registry";

export type SidebarIndicatorTab =
  | "project"
  | "tasks"
  | "git"
  | "registry"
  | "scripts"
  | "idx"
  | "session"
  | "settings";

export type SidebarIndicatorTone = "info" | "warning" | "error";

export interface SidebarIndicator {
  readonly tone: SidebarIndicatorTone;
  readonly reason: string;
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
  readonly scripts: RuntimeIndicatorPoll;
  readonly idx: RuntimeIndicatorPoll;
  readonly settings: {
    readonly errors: readonly string[];
  };
  readonly checkedAtMs: number;
}

interface RuntimeIndicatorPoll {
  readonly runningIds: readonly string[];
  readonly failedIds: readonly string[];
  readonly error?: string;
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
  readonly sessionNeedsInput: boolean;
  readonly openTodoCount: number;
  readonly activeSubagentCount: number;
  readonly settingsPanelError?: string | null;
}

export type SidebarIndicatorMap = Readonly<Partial<Record<SidebarIndicatorTab, SidebarIndicator>>>;

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

  indicators.registry = strongestIndicator(
    errorIndicator(inputs.registrySnapshot?.error),
    inputs.registrySnapshot?.projectIssue
      ? { tone: "warning", reason: inputs.registrySnapshot.projectIssue }
      : undefined,
    registryHasAttention(inputs.registrySnapshot)
      ? { tone: "warning", reason: "Registry has resources that need attention" }
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
    idxKnowledgeNeedsAttention(idxOverview?.wikiStatus)
      ? { tone: "warning", reason: "Knowledge base needs maintenance" }
      : undefined,
    (poll?.idx.runningIds.length ?? 0) > 0
      ? { tone: "info", reason: "IDX maintenance is running" }
      : undefined,
  );

  indicators.session = strongestIndicator(
    inputs.sessionNeedsInput
      ? { tone: "warning", reason: "The active session is waiting for your input" }
      : undefined,
    inputs.openTodoCount > 0
      ? { tone: "warning", reason: `${inputs.openTodoCount} open session todo${inputs.openTodoCount === 1 ? "" : "s"}` }
      : undefined,
    inputs.activeSubagentCount > 0
      ? { tone: "info", reason: `${inputs.activeSubagentCount} active subagent${inputs.activeSubagentCount === 1 ? "" : "s"}` }
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

function errorIndicator(reason: string | null | undefined): SidebarIndicator | undefined {
  return reason?.trim() ? { tone: "error", reason: reason.trim() } : undefined;
}

const FAST_ACTIVE_MS = 5_000;
const FAST_BACKGROUND_MS = 30_000;
const IDX_ACTIVE_MS = 60_000;
const IDX_BACKGROUND_MS = 180_000;
const EVENT_REFRESH_DELAY_MS = 180;

/**
 * Long-lived Activity Bar polling service. Fast polls use the lightweight
 * workspace status command; the more expensive IDX health snapshot has its own
 * slower cadence. Terminal/IDX events invalidate the fast snapshot immediately.
 */
export class SidebarIndicatorService {
  private state: SidebarIndicatorServiceState = {
    unseenScriptFailureIds: [],
    unseenIdxFailureIds: [],
  };
  private workspace = "";
  private viewedTab: SidebarIndicatorTab | undefined;
  private acknowledgedScriptFailures = new Set<string>();
  private acknowledgedIdxFailures = new Set<string>();
  private fastTimer: number | undefined;
  private idxTimer: number | undefined;
  private eventRefreshTimer: number | undefined;
  private fastGeneration = 0;
  private idxGeneration = 0;
  private fastRunning = false;
  private fastQueued = false;
  private idxRunning = false;
  private idxQueued = false;
  private started = false;
  private destroyed = false;
  private unlisteners: UnlistenFn[] = [];

  constructor(
    private readonly windowLabel: string,
    private readonly onChange: (state: SidebarIndicatorServiceState) => void,
  ) {}

  start(workspace: string): void {
    if (this.destroyed) return;
    if (this.started) {
      this.setWorkspace(workspace);
      return;
    }
    this.started = true;
    this.workspace = workspace;
    this.attachListeners();
    window.addEventListener("focus", this.handleForeground);
    document.addEventListener("visibilitychange", this.handleForeground);
    this.publish();
    this.refreshNow();
  }

  setWorkspace(workspace: string): void {
    if (workspace === this.workspace) return;
    this.workspace = workspace;
    this.fastGeneration += 1;
    this.idxGeneration += 1;
    this.acknowledgedScriptFailures.clear();
    this.acknowledgedIdxFailures.clear();
    this.state = {
      unseenScriptFailureIds: [],
      unseenIdxFailureIds: [],
    };
    this.clearTimers();
    this.publish();
    this.refreshNow();
  }

  setViewedTab(tab: SidebarIndicatorTab | undefined): void {
    const previous = this.viewedTab;
    this.viewedTab = tab;
    if (tab === "idx" && previous !== "idx") this.idxGeneration += 1;
    this.acknowledgeVisibleFailures();
    this.publishRuntimeState();
    if (previous === "idx" && tab !== "idx") void this.refreshIdx();
  }

  setIdxOverview(workspace: string, overview: IdxOverview | undefined): void {
    if (this.destroyed || workspace !== this.workspace) return;
    // A mounted IDX panel is the fresher owner while visible. Invalidate any
    // slower service request that was already in flight before the panel opened.
    this.idxGeneration += 1;
    this.state = { ...this.state, idxOverview: overview, idxPollError: undefined };
    this.publish();
  }

  refreshNow(): void {
    void this.refreshFast();
    void this.refreshIdx();
  }

  invalidateFast(): void {
    void this.refreshFast();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearTimers();
    window.removeEventListener("focus", this.handleForeground);
    document.removeEventListener("visibilitychange", this.handleForeground);
    for (const unlisten of this.unlisteners) unlisten();
    this.unlisteners = [];
  }

  private readonly handleForeground = (): void => {
    if (document.visibilityState !== "visible") return;
    this.refreshNow();
  };

  private attachListeners(): void {
    const register = <T>(event: string, handler: (payload: T) => void): void => {
      void listen<T>(event, ({ payload }) => handler(payload))
        .then((unlisten) => this.destroyed ? unlisten() : this.unlisteners.push(unlisten))
        .catch(() => {
          // Polling remains authoritative if event subscription is unavailable.
        });
    };
    register<PackageTerminalOutputEvent>(PACKAGE_TERMINAL_OUTPUT_EVENT, (payload) => {
      if (runtimeOutputNeedsRefresh(this.state.poll?.scripts.runningIds, payload.terminalId)) {
        this.scheduleEventRefresh();
      }
    });
    register<PackageTerminalExitEvent>(PACKAGE_TERMINAL_EXIT_EVENT, () => this.scheduleEventRefresh());
    register<IdxOperationOutputEvent>(IDX_OPERATION_OUTPUT_EVENT, (payload) => {
      if (runtimeOutputNeedsRefresh(this.state.poll?.idx.runningIds, payload.operationId)) {
        this.scheduleEventRefresh();
      }
    });
    register<IdxOperationExitEvent>(IDX_OPERATION_EXIT_EVENT, () => this.scheduleEventRefresh());
  }

  private scheduleEventRefresh(): void {
    if (this.eventRefreshTimer !== undefined || this.destroyed) return;
    this.eventRefreshTimer = window.setTimeout(() => {
      this.eventRefreshTimer = undefined;
      void this.refreshFast();
    }, EVENT_REFRESH_DELAY_MS);
  }

  private async refreshFast(): Promise<void> {
    if (this.destroyed || !this.workspace) {
      this.scheduleFast();
      return;
    }
    if (this.fastRunning) {
      this.fastQueued = true;
      return;
    }
    this.fastRunning = true;
    const workspace = this.workspace;
    const generation = ++this.fastGeneration;
    try {
      const poll = await invoke<WorkspaceSidebarIndicatorPoll>("workspace_sidebar_indicator_poll", {
        windowLabel: this.windowLabel,
        workspace,
      });
      if (this.destroyed || workspace !== this.workspace || generation !== this.fastGeneration) return;
      this.state = { ...this.state, poll };
      this.reconcileFailureAcknowledgements();
      this.acknowledgeVisibleFailures();
      this.publishRuntimeState();
    } catch (caught) {
      if (this.destroyed || workspace !== this.workspace || generation !== this.fastGeneration) return;
      const reason = caught instanceof Error ? caught.message : String(caught);
      const previousPoll = this.state.poll;
      this.state = {
        ...this.state,
        poll: previousPoll
          ? { ...previousPoll, project: { error: reason }, checkedAtMs: Date.now() }
          : {
              project: { error: reason },
              git: { available: false, dirty: false, conflicted: false, detached: false, ahead: 0, behind: 0 },
              scripts: { runningIds: [], failedIds: [] },
              idx: { runningIds: [], failedIds: [] },
              settings: { errors: [] },
              checkedAtMs: Date.now(),
            },
      };
      this.publishRuntimeState();
    } finally {
      this.fastRunning = false;
      if (this.fastQueued) {
        this.fastQueued = false;
        void this.refreshFast();
      } else {
        this.scheduleFast();
      }
    }
  }

  private async refreshIdx(): Promise<void> {
    if (this.destroyed || !this.workspace) {
      this.scheduleIdx();
      return;
    }
    // The mounted IDX panel already refreshes its overview every 30 seconds and
    // feeds the result back through setIdxOverview. Avoid duplicate CLI work.
    if (this.viewedTab === "idx") {
      this.scheduleIdx();
      return;
    }
    if (this.idxRunning) {
      this.idxQueued = true;
      return;
    }
    this.idxRunning = true;
    const workspace = this.workspace;
    const generation = ++this.idxGeneration;
    try {
      const overview = await invoke<IdxOverview>("idx_overview", { workspace });
      if (this.destroyed || workspace !== this.workspace || generation !== this.idxGeneration) return;
      this.state = { ...this.state, idxOverview: overview, idxPollError: undefined };
      this.publish();
    } catch (caught) {
      if (this.destroyed || workspace !== this.workspace || generation !== this.idxGeneration) return;
      this.state = {
        ...this.state,
        idxPollError: caught instanceof Error ? caught.message : String(caught),
      };
      this.publish();
    } finally {
      this.idxRunning = false;
      if (this.idxQueued) {
        this.idxQueued = false;
        void this.refreshIdx();
      } else {
        this.scheduleIdx();
      }
    }
  }

  private reconcileFailureAcknowledgements(): void {
    const poll = this.state.poll;
    if (!poll) return;
    const scriptFailures = new Set(poll.scripts.failedIds);
    const idxFailures = new Set(poll.idx.failedIds);
    this.acknowledgedScriptFailures = new Set(
      [...this.acknowledgedScriptFailures].filter((id) => scriptFailures.has(id)),
    );
    this.acknowledgedIdxFailures = new Set(
      [...this.acknowledgedIdxFailures].filter((id) => idxFailures.has(id)),
    );
  }

  private acknowledgeVisibleFailures(): void {
    const poll = this.state.poll;
    if (!poll) return;
    if (this.viewedTab === "scripts") {
      for (const id of poll.scripts.failedIds) this.acknowledgedScriptFailures.add(id);
    }
    if (this.viewedTab === "idx") {
      for (const id of poll.idx.failedIds) this.acknowledgedIdxFailures.add(id);
    }
  }

  private publishRuntimeState(): void {
    const poll = this.state.poll;
    this.state = {
      ...this.state,
      unseenScriptFailureIds: poll
        ? poll.scripts.failedIds.filter((id) => !this.acknowledgedScriptFailures.has(id))
        : [],
      unseenIdxFailureIds: poll
        ? poll.idx.failedIds.filter((id) => !this.acknowledgedIdxFailures.has(id))
        : [],
    };
    this.publish();
  }

  private publish(): void {
    this.onChange(this.state);
  }

  private scheduleFast(): void {
    if (this.destroyed) return;
    if (this.fastTimer !== undefined) window.clearTimeout(this.fastTimer);
    this.fastTimer = window.setTimeout(() => {
      this.fastTimer = undefined;
      void this.refreshFast();
    }, this.foreground() ? FAST_ACTIVE_MS : FAST_BACKGROUND_MS);
  }

  private scheduleIdx(): void {
    if (this.destroyed) return;
    if (this.idxTimer !== undefined) window.clearTimeout(this.idxTimer);
    this.idxTimer = window.setTimeout(() => {
      this.idxTimer = undefined;
      void this.refreshIdx();
    }, this.foreground() ? IDX_ACTIVE_MS : IDX_BACKGROUND_MS);
  }

  private foreground(): boolean {
    return document.visibilityState === "visible" && document.hasFocus();
  }

  private clearTimers(): void {
    if (this.fastTimer !== undefined) window.clearTimeout(this.fastTimer);
    if (this.idxTimer !== undefined) window.clearTimeout(this.idxTimer);
    if (this.eventRefreshTimer !== undefined) window.clearTimeout(this.eventRefreshTimer);
    this.fastTimer = undefined;
    this.idxTimer = undefined;
    this.eventRefreshTimer = undefined;
  }
}
