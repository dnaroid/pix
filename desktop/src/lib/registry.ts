import type { SessionStateNotification } from "./session-state";

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
