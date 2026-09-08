import type { SessionStateNotification } from "./session-state";
import { fuzzySearch } from "./fuzzy";

export const REGISTRY_STATE_CHANNEL = "pi-tools-suite:resource-registry:state";

export type RegistryResourceType = "skill" | "agent" | "project";
export type RegistryProjectArtifact = "tasks" | "plans" | "todo";
export type RegistryStatus =
  | "up-to-date"
  | "update-available"
  | "local-changes"
  | "diverged"
  | "not-installed"
  | "local-only"
  | "untracked-local"
  | "missing-local"
  | "removed-remote"
  | "registry-changed";

export type RegistryItemAction = "install" | "update" | "push" | "pull" | "uninstall" | "remove";

export interface RegistryItem {
  readonly id: string;
  readonly type: RegistryResourceType;
  readonly name: string;
  readonly artifact?: RegistryProjectArtifact;
  readonly status: RegistryStatus;
  readonly statusLabel: string;
  readonly icon: string;
  readonly description?: string;
  readonly local: boolean;
  readonly remote: boolean;
  readonly actions: RegistryItemAction[];
}

export interface RegistrySnapshot {
  readonly version: 1;
  readonly configured: boolean;
  readonly remote?: string;
  readonly branch: string;
  readonly projectKey?: string;
  readonly projectIssue?: string;
  readonly items: RegistryItem[];
  readonly checkedAt: string;
  readonly error?: string;
}

export type RegistryActionRequest =
  | { readonly action: "refresh" | "configure" | "project-key" }
  | {
      readonly action: "install" | "update" | "push" | "uninstall" | "remove";
      readonly type: "skill" | "agent";
      readonly name: string;
    }
  | {
      readonly action: "push-project" | "pull-project";
      readonly scope: RegistryProjectArtifact | "project";
    };

const RESOURCE_TYPES = new Set<RegistryResourceType>(["skill", "agent", "project"]);
const PROJECT_ARTIFACTS = new Set<RegistryProjectArtifact>(["tasks", "plans", "todo"]);
const STATUSES = new Set<RegistryStatus>([
  "up-to-date",
  "update-available",
  "local-changes",
  "diverged",
  "not-installed",
  "local-only",
  "untracked-local",
  "missing-local",
  "removed-remote",
  "registry-changed",
]);
const ACTIONS = new Set<RegistryItemAction>(["install", "update", "push", "pull", "uninstall", "remove"]);

export function registrySnapshotFromSessionState(
  notification: SessionStateNotification,
): RegistrySnapshot | undefined {
  if (notification.channel !== REGISTRY_STATE_CHANNEL) return undefined;
  return parseRegistrySnapshot(notification.data);
}

export function registryHasAttention(snapshot: RegistrySnapshot | undefined): boolean {
  if (!snapshot) return false;
  return snapshot.items.some((item) =>
    item.status === "update-available"
    || item.status === "missing-local"
    || item.status === "diverged"
    || item.status === "registry-changed"
  );
}

export function registryPrimaryAction(item: RegistryItem): RegistryItemAction | undefined {
  return item.actions.find((action) => action !== "uninstall" && action !== "remove");
}

export function registryActionLabel(action: RegistryItemAction): string {
  switch (action) {
    case "install": return "Install";
    case "update": return "Update";
    case "push": return "Push";
    case "pull": return "Pull";
    case "uninstall": return "Uninstall local";
    case "remove": return "Remove from registry";
  }
}

export function registryFriendlyStatusLabel(item: RegistryItem): string {
  switch (item.status) {
    case "up-to-date": return "Synced";
    case "update-available": return "Update available";
    case "local-changes": return "Local changes";
    case "diverged": return "Conflict";
    case "not-installed": return item.type === "project" ? "Remote only" : "Available";
    case "local-only": return "Local only";
    case "untracked-local": return "Needs review";
    case "missing-local": return "Missing locally";
    case "removed-remote": return "Not in registry";
    case "registry-changed": return "Different registry";
  }
}

export function registryFriendlyStatusDescription(item: RegistryItem): string {
  switch (item.status) {
    case "up-to-date": return "Installed here and matches the registry.";
    case "update-available": return "Installed here; a newer registry version is available.";
    case "local-changes": return "Installed here; local changes are not in the registry yet.";
    case "diverged": return "Local and registry copies both changed.";
    case "not-installed": return item.type === "project"
      ? "Exists in the registry, but not in this project."
      : "Available in the registry, but not installed in this project.";
    case "local-only": return "Only in this project; it has not been added to the registry.";
    case "untracked-local": return "Exists both here and in the registry, but the copies are not linked.";
    case "missing-local": return "Tracked for this project, but the local copy is missing.";
    case "removed-remote": return "Installed here, but its registry copy was removed.";
    case "registry-changed": return "This local copy is linked to a different registry or project key.";
  }
}

export function registryFriendlyActionLabel(item: RegistryItem, action: RegistryItemAction): string {
  if (item.status === "untracked-local" && action === "push") return "Keep local version";
  if (item.status === "untracked-local" && action === "pull") return "Keep registry version";
  if (item.status === "removed-remote" && action === "push") return "Restore in registry";
  if (item.status === "local-only" && action === "push") return "Add to registry";
  if (item.status === "local-changes" && action === "push") return "Sync to registry";
  if (action === "install") return "Install here";
  if (action === "update" || action === "pull") return "Update local";
  if (action === "push") return item.remote ? "Sync to registry" : "Add to registry";
  return registryActionLabel(action);
}

export function compareRegistryItems(left: RegistryItem, right: RegistryItem): number {
  if (left.type === "project" && right.type !== "project") return 1;
  if (right.type === "project" && left.type !== "project") return -1;
  if (left.type !== "project" && right.type !== "project" && left.local !== right.local) {
    return left.local ? -1 : 1;
  }
  const byAttention = registryStatusRank(left.status) - registryStatusRank(right.status);
  if (byAttention !== 0) return byAttention;
  const byType = left.type.localeCompare(right.type);
  return byType !== 0 ? byType : left.name.localeCompare(right.name);
}

export function searchRegistryItems(items: readonly RegistryItem[], query: string): RegistryItem[] {
  const ordered = [...items].sort(compareRegistryItems);
  if (!query.trim()) return ordered;

  return fuzzySearch(
    ordered.map((item) => ({
      value: item,
      label: item.name,
      ...(item.description ? { aliases: [item.description] } : {}),
    })),
    query,
    {
      includeEmptyQuery: false,
      minScorePerCharacter: 14,
    },
  ).map((match) => match.value);
}

function registryStatusRank(status: RegistryStatus): number {
  switch (status) {
    case "diverged": return 0;
    case "registry-changed": return 1;
    case "untracked-local": return 2;
    case "local-changes": return 3;
    case "update-available": return 4;
    case "missing-local": return 5;
    case "removed-remote": return 6;
    case "local-only": return 7;
    case "up-to-date": return 8;
    case "not-installed": return 9;
  }
}

function parseRegistrySnapshot(value: unknown): RegistrySnapshot | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.configured !== "boolean") return undefined;
  if (typeof value.branch !== "string" || !Array.isArray(value.items) || typeof value.checkedAt !== "string") return undefined;
  if (value.remote !== undefined && typeof value.remote !== "string") return undefined;
  if (value.projectKey !== undefined && typeof value.projectKey !== "string") return undefined;
  if (value.projectIssue !== undefined && typeof value.projectIssue !== "string") return undefined;
  if (value.error !== undefined && typeof value.error !== "string") return undefined;

  const items: RegistryItem[] = [];
  for (const candidate of value.items) {
    const item = parseRegistryItem(candidate);
    if (!item) return undefined;
    items.push(item);
  }
  return {
    version: 1,
    configured: value.configured,
    ...(typeof value.remote === "string" ? { remote: value.remote } : {}),
    branch: value.branch,
    ...(typeof value.projectKey === "string" ? { projectKey: value.projectKey } : {}),
    ...(typeof value.projectIssue === "string" ? { projectIssue: value.projectIssue } : {}),
    items,
    checkedAt: value.checkedAt,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

function parseRegistryItem(value: unknown): RegistryItem | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || !value.id) return undefined;
  if (typeof value.type !== "string" || !RESOURCE_TYPES.has(value.type as RegistryResourceType)) return undefined;
  if (typeof value.name !== "string" || !value.name) return undefined;
  if (typeof value.status !== "string" || !STATUSES.has(value.status as RegistryStatus)) return undefined;
  if (typeof value.statusLabel !== "string" || typeof value.icon !== "string") return undefined;
  if (typeof value.local !== "boolean" || typeof value.remote !== "boolean" || !Array.isArray(value.actions)) return undefined;
  if (value.description !== undefined && typeof value.description !== "string") return undefined;
  if (value.artifact !== undefined && (typeof value.artifact !== "string" || !PROJECT_ARTIFACTS.has(value.artifact as RegistryProjectArtifact))) {
    return undefined;
  }
  const actions: RegistryItemAction[] = [];
  for (const action of value.actions) {
    if (typeof action !== "string" || !ACTIONS.has(action as RegistryItemAction)) return undefined;
    actions.push(action as RegistryItemAction);
  }
  return {
    id: value.id,
    type: value.type as RegistryResourceType,
    name: value.name,
    ...(typeof value.artifact === "string" ? { artifact: value.artifact as RegistryProjectArtifact } : {}),
    status: value.status as RegistryStatus,
    statusLabel: value.statusLabel,
    icon: value.icon,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    local: value.local,
    remote: value.remote,
    actions,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
