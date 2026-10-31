import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  PACKAGE_TERMINAL_EXIT_EVENT,
  PACKAGE_TERMINAL_OUTPUT_EVENT,
  type PackageTerminalExitEvent,
  type PackageTerminalOutputEvent,
} from "./package-scripts";
import { createFailureStreakReporter } from "./diagnostic-logging";
import {
  mergeStableRegistryIndicatorPoll,
  runtimeOutputNeedsRefresh,
} from "./sidebar-indicator-policy";
import type {
  SidebarGitRemoteUpdateProbe,
  SidebarIndicatorServiceState,
  SidebarIndicatorTab,
  WorkspaceSidebarIndicatorPoll,
} from "./sidebar-indicator-types";

const FAST_ACTIVE_MS = 5_000;
const FAST_BACKGROUND_MS = 30_000;
const GIT_REMOTE_ACTIVE_MS = 60_000;
const GIT_REMOTE_BACKGROUND_MS = 5 * 60_000;
const GIT_REMOTE_FOCUS_MIN_MS = 30_000;
const EVENT_REFRESH_DELAY_MS = 180;

/**
 * Long-lived Activity Bar polling service. Fast polls use the lightweight
 * local workspace status command. Remote Git freshness is a separate, sparse
 * ls-remote probe that does not fetch objects or update refs. Terminal events
 * invalidate the fast snapshot
 * immediately.
 */
export class SidebarIndicatorService {
  private state: SidebarIndicatorServiceState = {
    unseenScriptFailureIds: [],
  };
  private workspace = "";
  private viewedTab: SidebarIndicatorTab | undefined;
  private acknowledgedScriptFailures = new Set<string>();
  private fastTimer: number | undefined;
  private gitRemoteTimer: number | undefined;
  private eventRefreshTimer: number | undefined;
  private fastGeneration = 0;
  private gitRemoteGeneration = 0;
  private fastRunning = false;
  private fastQueued = false;
  private gitRemoteRunning = false;
  private gitRemoteQueued = false;
  private gitRemoteLastAttemptMs = 0;
  private started = false;
  private destroyed = false;
  private unlisteners: UnlistenFn[] = [];
  private publishedSignature: string | undefined;
  // Offline/auth failures recur every probe; log the first of each streak.
  private readonly gitRemoteFailures = createFailureStreakReporter((error) => (
    this.reportWarning?.("sidebar:git-remote-probe", error)
  ));

  constructor(
    private readonly windowLabel: string,
    private readonly onChange: (state: SidebarIndicatorServiceState) => void,
    private readonly refreshCiIndicator?: () => void,
    private readonly reportWarning?: (label: string, error: unknown) => void,
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
    if (this.destroyed || workspace === this.workspace) return;
    this.workspace = workspace;
    this.fastGeneration += 1;
    this.gitRemoteGeneration += 1;
    this.gitRemoteLastAttemptMs = 0;
    this.gitRemoteFailures.success(); // a new workspace starts a new streak
    this.acknowledgedScriptFailures.clear();
    this.state = {
      unseenScriptFailureIds: [],
    };
    this.clearTimers();
    this.publish();
    this.refreshNow();
  }

  setViewedTab(tab: SidebarIndicatorTab | undefined): void {
    if (this.destroyed) return;
    this.viewedTab = tab;
    this.acknowledgeVisibleFailures();
    this.publishRuntimeState();
  }

  refreshNow(): void {
    void this.refreshFast();
    this.refreshGitRemoteIfDue();
  }

  /**
   * Owner snapshots (Git panel, Registry, CI) can change in bursts. Coalesce
   * them into one debounced fast poll instead of stacking extra IPC/Git work
   * on top of the regular cadence.
   */
  invalidateFast(): void {
    this.scheduleEventRefresh();
  }

  invalidateGitRemote(force = false): void {
    if (!force && !this.state.gitRemote?.hasUpdates) return;
    void this.refreshGitRemote();
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
    // focus and visibilitychange usually fire together; an in-flight poll
    // already reflects the foreground moment, so do not queue a second one.
    void this.refreshFast(false);
    this.refreshGitRemoteIfDue();
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
  }

  private scheduleEventRefresh(): void {
    if (this.eventRefreshTimer !== undefined || this.destroyed) return;
    this.eventRefreshTimer = window.setTimeout(() => {
      this.eventRefreshTimer = undefined;
      void this.refreshFast();
    }, EVENT_REFRESH_DELAY_MS);
  }

  private async refreshFast(queueIfRunning = true): Promise<void> {
    if (this.destroyed || !this.workspace) {
      this.scheduleFast();
      return;
    }
    if (this.fastRunning) {
      if (queueIfRunning) this.fastQueued = true;
      return;
    }
    if (this.eventRefreshTimer !== undefined) {
      window.clearTimeout(this.eventRefreshTimer);
      this.eventRefreshTimer = undefined;
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
      this.state = {
        ...this.state,
        poll,
      };
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

  private refreshGitRemoteIfDue(): void {
    if (Date.now() - this.gitRemoteLastAttemptMs < GIT_REMOTE_FOCUS_MIN_MS) return;
    void this.refreshGitRemote();
  }

  private async refreshGitRemote(): Promise<void> {
    if (this.destroyed || !this.workspace) {
      this.scheduleGitRemote();
      return;
    }
    if (this.gitRemoteRunning) {
      this.gitRemoteQueued = true;
      return;
    }
    this.gitRemoteRunning = true;
    this.gitRemoteLastAttemptMs = Date.now();
    this.refreshCiIndicator?.();
    const workspace = this.workspace;
    const generation = ++this.gitRemoteGeneration;
    try {
      const gitRemote = await invoke<SidebarGitRemoteUpdateProbe>("workspace_git_remote_update_probe", {
        workspace,
      });
      if (this.destroyed || workspace !== this.workspace || generation !== this.gitRemoteGeneration) return;
      this.gitRemoteFailures.success();
      this.state = { ...this.state, gitRemote };
      this.publish();
    } catch (error) {
      // Remote freshness is best-effort. Offline/auth failures must never turn
      // a background attention hint into an error or block other sidebar state.
      if (!this.destroyed && workspace === this.workspace && generation === this.gitRemoteGeneration) {
        this.gitRemoteFailures.failure(error);
      }
    } finally {
      this.gitRemoteRunning = false;
      if (this.gitRemoteQueued) {
        this.gitRemoteQueued = false;
        void this.refreshGitRemote();
      } else {
        this.scheduleGitRemote();
      }
    }
  }

  private reconcileFailureAcknowledgements(): void {
    const poll = this.state.poll;
    if (!poll) return;
    const scriptFailures = new Set(poll.scripts.failedIds);
    this.acknowledgedScriptFailures = new Set(
      [...this.acknowledgedScriptFailures].filter((id) => scriptFailures.has(id)),
    );
  }

  private acknowledgeVisibleFailures(): void {
    const poll = this.state.poll;
    if (!poll) return;
    if (this.viewedTab === "scripts") {
      for (const id of poll.scripts.failedIds) this.acknowledgedScriptFailures.add(id);
    }
  }

  private publishRuntimeState(): void {
    const poll = this.state.poll;
    this.state = {
      ...this.state,
      unseenScriptFailureIds: poll
        ? poll.scripts.failedIds.filter((id) => !this.acknowledgedScriptFailures.has(id))
        : [],
    };
    this.publish();
  }

  /**
   * Skip identical snapshots so a steady 5-second poll does not re-run every
   * derived indicator/menu computation. A poll that reports Registry project
   * changes is always delivered: its fresh checkedAtMs drives local reloads.
   */
  private publish(): void {
    if (this.destroyed) return;
    const signature = sidebarIndicatorStateSignature(this.state);
    if (signature !== undefined && signature === this.publishedSignature) return;
    this.publishedSignature = signature;
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

  private scheduleGitRemote(): void {
    if (this.destroyed) return;
    if (this.gitRemoteTimer !== undefined) window.clearTimeout(this.gitRemoteTimer);
    this.gitRemoteTimer = window.setTimeout(() => {
      this.gitRemoteTimer = undefined;
      void this.refreshGitRemote();
    }, this.foreground() ? GIT_REMOTE_ACTIVE_MS : GIT_REMOTE_BACKGROUND_MS);
  }

  private foreground(): boolean {
    return document.visibilityState === "visible" && document.hasFocus();
  }

  private clearTimers(): void {
    if (this.fastTimer !== undefined) window.clearTimeout(this.fastTimer);
    if (this.gitRemoteTimer !== undefined) window.clearTimeout(this.gitRemoteTimer);
    if (this.eventRefreshTimer !== undefined) window.clearTimeout(this.eventRefreshTimer);
    this.fastTimer = undefined;
    this.gitRemoteTimer = undefined;
    this.eventRefreshTimer = undefined;
  }
}

/** Content identity without poll timestamps; undefined means always publish. */
export function sidebarIndicatorStateSignature(state: SidebarIndicatorServiceState): string | undefined {
  if ((state.poll?.registry.projectChanges?.length ?? 0) > 0) return undefined;
  return JSON.stringify([
    state.poll ? { ...state.poll, checkedAtMs: 0 } : null,
    state.gitRemote?.hasUpdates ?? null,
    state.unseenScriptFailureIds,
  ]);
}
