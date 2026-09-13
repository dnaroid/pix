import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  IDX_OPERATION_EXIT_EVENT,
  IDX_OPERATION_OUTPUT_EVENT,
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
import {
  mergeStableRegistryIndicatorPoll,
  runtimeOutputNeedsRefresh,
} from "./sidebar-indicator-policy";
import type {
  SidebarIndicatorServiceState,
  SidebarIndicatorTab,
  WorkspaceSidebarIndicatorPoll,
} from "./sidebar-indicator-types";

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
      const nextPoll = await invoke<WorkspaceSidebarIndicatorPoll>("workspace_sidebar_indicator_poll", {
        windowLabel: this.windowLabel,
        workspace,
      });
      if (this.destroyed || workspace !== this.workspace || generation !== this.fastGeneration) return;
      const poll = mergeStableRegistryIndicatorPoll(this.state.poll, nextPoll);
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
              registry: { localChanges: false, stable: true },
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
