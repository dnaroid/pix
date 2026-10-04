import type { SidebarIndicatorReason, SidebarIndicatorReasonId } from "./sidebar-indicator-types";

export type SidebarIndicatorActionId =
  | "project.retry" | "tasks.reload" | "tasks.show" | "tasks.running"
  | "git.refresh" | "git.ci" | "git.fix-ci" | "git.conflicts" | "git.branch"
  | "git.fetch" | "git.changes" | "git.push" | "git.incoming" | "git.commit-push"
  | "registry.refresh" | "registry.review" | "registry.sync"
  | "scripts.inspect" | "scripts.running"
  | "idx.inspect" | "idx.review" | "idx.maintenance" | "idx.running"
  | "settings.inspect";

export interface SidebarIndicatorAction {
  readonly id: SidebarIndicatorActionId;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SidebarIndicatorActionGroup {
  readonly id: SidebarIndicatorReasonId;
  readonly reason: string;
  readonly actions: readonly SidebarIndicatorAction[];
}

const ACTIONS: Record<SidebarIndicatorActionId, string> = {
  "project.retry": "Reload project files",
  "tasks.reload": "Retry loading tasks",
  "tasks.show": "Show planned tasks",
  "tasks.running": "Open running task session",
  "git.refresh": "Retry Git status",
  "git.ci": "Inspect failed CI",
  "git.fix-ci": "Fix CI with AI",
  "git.conflicts": "Inspect conflicts",
  "git.branch": "Choose or create a branch…",
  "git.fetch": "Fetch upstream",
  "git.changes": "Review working tree changes",
  "git.commit-push": "Stage all, AI commit & push",
  "git.push": "Push commits",
  "git.incoming": "Review incoming changes…",
  "registry.refresh": "Retry Registry check",
  "registry.review": "Review resource changes…",
  "registry.sync": "Inspect project sync…",
  "scripts.inspect": "Inspect terminal / launch errors",
  "scripts.running": "Show running terminals",
  "idx.inspect": "Inspect IDX error",
  "idx.review": "AI review",
  "idx.maintenance": "Open index maintenance…",
  "idx.running": "Show maintenance output",
  "settings.inspect": "Inspect configuration errors",
};

const REASON_ACTIONS: Record<SidebarIndicatorReasonId, readonly SidebarIndicatorActionId[]> = {
  "project.error": ["project.retry"],
  "tasks.error": ["tasks.reload"],
  "tasks.running": ["tasks.running"],
  "tasks.planned": ["tasks.show"],
  "git.error": ["git.refresh"],
  "git.ci-failed": ["git.ci", "git.fix-ci"],
  "git.conflicts": ["git.conflicts"],
  "git.detached": ["git.branch"],
  "git.remote": ["git.fetch"],
  "git.dirty": ["git.changes", "git.commit-push"],
  "git.ahead": ["git.push"],
  "git.behind": ["git.incoming"],
  "registry.error": ["registry.refresh", "registry.sync"],
  "registry.issue": ["registry.review"],
  "registry.attention": ["registry.review"],
  "registry.syncing": ["registry.sync"],
  "registry.pending": ["registry.sync"],
  "registry.local": ["registry.review"],
  "scripts.error": ["scripts.inspect"],
  "scripts.failed": ["scripts.inspect"],
  "scripts.running": ["scripts.running"],
  "idx.error": ["idx.inspect"],
  "idx.failed": ["idx.inspect"],
  "idx.unavailable": ["idx.inspect"],
  "idx.dirty": ["idx.review"],
  "idx.stale": ["idx.maintenance"],
  "idx.running": ["idx.running"],
  "settings.error": ["settings.inspect"],
};

/** No generic section commands: the current reasons alone determine the menu. */
export function sidebarIndicatorActionGroups(
  reasons: readonly SidebarIndicatorReason[] = [],
  enabled: Partial<Record<SidebarIndicatorActionId, boolean>> = {},
): readonly SidebarIndicatorActionGroup[] {
  const groups = new Map<SidebarIndicatorReasonId, SidebarIndicatorActionGroup>();
  for (const reason of reasons) {
    const previous = groups.get(reason.id);
    groups.set(reason.id, {
      id: reason.id,
      reason: previous && previous.reason !== reason.reason
        ? `${previous.reason}; ${reason.reason}` : reason.reason,
      actions: REASON_ACTIONS[reason.id].map((id) => ({ id, label: ACTIONS[id], disabled: enabled[id] === false })),
    });
  }
  return [...groups.values()];
}
