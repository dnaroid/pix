import type { SidebarIndicatorReason, SidebarIndicatorReasonId } from "./sidebar-indicator-types";

export type SidebarIndicatorReasonActionId =
  | "project.retry" | "tasks.reload" | "tasks.show" | "tasks.running"
  | "git.refresh" | "git.ci" | "git.fix-ci" | "git.conflicts" | "git.branch"
  | "git.fetch" | "git.changes" | "git.push" | "git.incoming" | "git.commit-push"
  | "registry.refresh" | "registry.review" | "registry.sync" | "registry.push-project-resources"
  | "scripts.inspect" | "scripts.running"
  | "search.inspect"
  | "settings.inspect";

export type SidebarIndicatorActionId = SidebarIndicatorReasonActionId | `scripts.command.${string}`;

export interface SidebarIndicatorAction {
  readonly id: SidebarIndicatorActionId;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SidebarIndicatorActionGroup {
  readonly id: SidebarIndicatorReasonId | "scripts.commands";
  readonly reason: string;
  readonly actions: readonly SidebarIndicatorAction[];
}

const ACTIONS: Record<SidebarIndicatorReasonActionId, string> = {
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
  "registry.push-project-resources": "Sync project changes to Registry",
  "scripts.inspect": "Inspect terminal / launch errors",
  "scripts.running": "Show running terminals",
  "settings.inspect": "Inspect configuration errors",
  "search.inspect": "Inspect search indexes",
};

const REASON_ACTIONS: Record<SidebarIndicatorReasonId, readonly SidebarIndicatorReasonActionId[]> = {
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
  "registry.local": ["registry.review", "registry.push-project-resources"],
  "scripts.error": ["scripts.inspect"],
  "scripts.failed": ["scripts.inspect"],
  "scripts.running": ["scripts.running"],
  "settings.error": ["settings.inspect"],
  "search.error": ["search.inspect"],
  "search.indexing": ["search.inspect"],
  "search.pending": ["search.inspect"],
};

/** No generic section commands: the current reasons alone determine the menu. */
export function sidebarIndicatorActionGroups(
  reasons: readonly SidebarIndicatorReason[] = [],
  enabled: Partial<Record<SidebarIndicatorActionId, boolean>> = {},
  gitRemotes: readonly string[] = [],
): readonly SidebarIndicatorActionGroup[] {
  const groups = new Map<SidebarIndicatorReasonId, SidebarIndicatorActionGroup>();
  for (const reason of reasons) {
    const previous = groups.get(reason.id);
    groups.set(reason.id, {
      id: reason.id,
      reason: previous && previous.reason !== reason.reason
        ? `${previous.reason}; ${reason.reason}` : reason.reason,
      actions: REASON_ACTIONS[reason.id]
        .filter((id) => gitRemotes.length > 0 || id !== "git.push")
        .map((id) => ({ id, label: id === "git.commit-push" && !gitRemotes.length ? "Stage all, AI commit" : ACTIONS[id], disabled: enabled[id] === false })),
    });
  }
  return [...groups.values()];
}
