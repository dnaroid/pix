import type { ToolCallStatus } from "@agentclientprotocol/sdk";
import { toolPresentationName } from "./tool-presentation";
import type {
  ActivityEntry,
  ActivityGroupItem,
  MessageItem,
  ToolItem,
  TranscriptDisplayItem,
  TranscriptItem,
} from "./transcript-types";

export function groupTranscriptItems(items: readonly TranscriptItem[]): TranscriptDisplayItem[] {
  const grouped: TranscriptDisplayItem[] = [];
  let entries: [ActivityEntry, ...ActivityEntry[]] | undefined;

  for (const item of items) {
    if (item.type === "message" && item.role !== "thought") {
      if (entries) {
        grouped.push(buildActivityGroup(entries));
        entries = undefined;
      }
      grouped.push(messageForDisplay(item));
      continue;
    }

    const entry = item as ActivityEntry;
    if (entries) entries.push(entry);
    else entries = [entry];
  }

  if (entries) grouped.push(buildActivityGroup(entries));
  return grouped;
}

function messageForDisplay(item: MessageItem): MessageItem {
  if (item.role !== "user") return item;
  const imageCount = item.attachments.filter((attachment) => attachment.kind === "image").length;
  if (imageCount === 0) return item;

  const text = item.text
    .replace(/^\[Image (\d+)\][ \t]*\r?$/gm, (marker, index: string) =>
      Number(index) <= imageCount ? "" : marker)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text === item.text ? item : { ...item, text };
}

function buildActivityGroup(entries: readonly [ActivityEntry, ...ActivityEntry[]]): ActivityGroupItem {
  const tools: ToolItem[] = [];
  let running = false;
  let pending = false;
  let earliestStart: number | undefined;
  let latestEnd: number | undefined;
  for (const entry of entries) {
    const { startedAtMs, endedAtMs } = entry;
    if (entry.type === "tool") {
      tools.push(entry);
      running ||= entry.status === "in_progress";
      pending ||= entry.status === "pending";
    } else {
      running ||= startedAtMs !== undefined && endedAtMs === undefined;
    }
    if (startedAtMs !== undefined) {
      earliestStart = earliestStart === undefined ? startedAtMs : Math.min(earliestStart, startedAtMs);
    }
    if (endedAtMs !== undefined) {
      latestEnd = latestEnd === undefined ? endedAtMs : Math.max(latestEnd, endedAtMs);
    }
  }
  const active = running || pending;
  const status: ToolCallStatus = running ? "in_progress" : pending ? "pending" : "completed";
  const durationMs = active ? undefined : elapsedDuration(earliestStart, latestEnd);

  return {
    type: "activity-group",
    id: `activity-group:${entries[0].id}`,
    entries,
    tools,
    status,
    active,
    ...(earliestStart !== undefined ? { startedAtMs: earliestStart } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** Returns a final duration or samples an active group's duration at `nowMs`. */
export function activityGroupDuration(
  item: Pick<ActivityGroupItem, "active" | "startedAtMs" | "durationMs">,
  nowMs?: number,
): number | undefined {
  return item.active ? elapsedDuration(item.startedAtMs, nowMs) : item.durationMs;
}

function elapsedDuration(startedAtMs: number | undefined, endedAtMs: number | undefined): number | undefined {
  return startedAtMs === undefined || endedAtMs === undefined
    ? undefined
    : Math.max(0, endedAtMs - startedAtMs);
}

export function activityEntryActive(entry: ActivityEntry): boolean {
  if (entry.type === "tool") return entry.status === "pending" || entry.status === "in_progress";
  return entry.startedAtMs !== undefined && entry.endedAtMs === undefined;
}

export interface ActivityGroupHeading {
  /** One deterministic action while live; the settled outcome otherwise. */
  readonly action: string;
  readonly active: boolean;
  /** Further active entries behind the selected action, for a `+N more` hint. */
  readonly moreCount: number;
  /** True when the group contains a failed tool call. */
  readonly failed: boolean;
}

const ACTIVITY_THINKING_ACTION = "Thinking";

const ACTIVITY_ACTIONS_BY_NAME: readonly (readonly [readonly string[], string])[] = [
  [["repo_context"], "Gathering project context"],
  [["repo_architecture"], "Exploring architecture"],
  [["repo_structure"], "Inspecting project structure"],
  [["repo_ast"], "Inspecting code structure"],
  [["repo_explain"], "Inspecting implementation"],
  [["repo_deps"], "Checking dependencies"],
  [["repo_audit"], "Auditing project knowledge"],
  [["session_overview", "session_read_section", "session_recovery_context"], "Reviewing session history"],
  [["session_search"], "Searching session history"],
  [["session_name"], "Naming session"],
  [["compress"], "Compacting context"],
  [["brainstorm"], "Consulting model council"],
  [["multi_tool_use", "parallel"], "Running parallel tools"],
  [["codemode"], "Running code"],
  [["read", "read_file", "readoutput"], "Reading code"],
  [["grep", "rg", "glob", "find", "search", "ast_grep"], "Searching project"],
  [
    ["edit", "multiedit", "write", "apply_patch", "ast_apply", "create_file", "update_file", "delete_file", "remove_file", "move_file", "rename_file"],
    "Making changes",
  ],
  [["bash", "shell", "shell_command", "exec", "execute", "run_command"], "Running command"],
  [["web_search"], "Searching the web"],
  [["web_fetch", "fetch"], "Reading web page"],
  [["subagent", "subagents", "agent", "agents", "task"], "Managing agents"],
  [["question"], "Waiting for input"],
  [["todo", "get_plan", "update_plan"], "Updating plan"],
];

const ACTIVITY_ACTIONS_BY_KIND: readonly (readonly [readonly string[], string])[] = [
  [["read"], "Reading code"],
  [["search"], "Searching project"],
  [["edit", "mutation", "write"], "Making changes"],
  [["execute"], "Running command"],
  [["agent"], "Managing agents"],
];

/**
 * One deterministic header action for an activity group: the most recent
 * active entry in entry order while anything is live, otherwise the settled
 * outcome (`Failed` when any tool call failed). This action is used by the
 * pinned composer status, not the neutral collapsed name list.
 * Derived only from normalized tool metadata (including the fixed action
 * cached at ingestion); rendering never inspects command text or payloads.
 */
export function activityGroupHeading(entries: readonly ActivityEntry[]): ActivityGroupHeading {
  let action: string | undefined;
  let activeCount = 0;
  let failed = false;
  for (const entry of entries) {
    failed ||= entry.type === "tool" && entry.status === "failed";
    if (!activityEntryActive(entry)) continue;
    activeCount += 1;
    action = entry.type === "tool" ? toolEntryAction(entry) : ACTIVITY_THINKING_ACTION;
  }
  return action === undefined
    ? { action: failed ? "Failed" : "Completed", active: false, moreCount: 0, failed }
    : { action, active: true, moreCount: activeCount - 1, failed };
}

export function toolEntryAction(tool: ToolItem): string {
  if (tool.skillName) return "Reading instructions";
  if (tool.activityAction) return tool.activityAction;
  const name = toolPresentationName(tool);
  for (const [names, action] of ACTIVITY_ACTIONS_BY_NAME) {
    if (names.includes(name)) return action;
  }
  if (name.startsWith("repo_")) return "Searching project";
  for (const [kinds, action] of ACTIVITY_ACTIONS_BY_KIND) {
    if (kinds.includes(tool.kind)) return action;
  }
  return "Running tool";
}

/**
 * Collapsed comma-list labels for an activity group: every distinct name in
 * first-seen order (deduplicated). SKILL.md reads label as `skill <name>`.
 */
export function activityGroupPresentationLabels(
  entries: readonly ActivityEntry[],
): string[] {
  const labels = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "tool") {
      const name = entry.skillName ? `skill ${entry.skillName}` : toolPresentationName(entry);
      labels.add(name);
    } else {
      labels.add("thinking");
    }
  }
  return [...labels];
}
export function formatTranscriptDuration(durationMs: number): string {
  const milliseconds = Math.max(0, durationMs);
  if (milliseconds < 100) return "<0.1s";
  if (milliseconds < 10_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1000)}s`;
  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}
