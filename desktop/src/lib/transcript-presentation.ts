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
  let failed = false;
  let running = false;
  let pending = false;
  let earliestStart: number | undefined;
  let latestEnd: number | undefined;
  for (const entry of entries) {
    const { startedAtMs, endedAtMs } = entry;
    if (entry.type === "tool") {
      tools.push(entry);
      failed ||= entry.status === "failed";
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
  const status: ToolCallStatus = failed ? "failed" : running ? "in_progress" : pending ? "pending" : "completed";
  const durationMs = !active && earliestStart !== undefined && latestEnd !== undefined
    ? Math.max(0, latestEnd - earliestStart)
    : undefined;

  return {
    type: "activity-group",
    id: `activity-group:${entries[0].id}`,
    entries,
    tools,
    status,
    active,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export function activityEntryActive(entry: ActivityEntry): boolean {
  if (entry.type === "tool") return entry.status === "pending" || entry.status === "in_progress";
  return entry.startedAtMs !== undefined && entry.endedAtMs === undefined;
}

export interface ActivityGroupPresentationLabel {
  readonly name: string;
  readonly active: boolean;
}

export function activityGroupPresentationLabels(
  entries: readonly ActivityEntry[],
): ActivityGroupPresentationLabel[] {
  const labels = new Map<string, ActivityGroupPresentationLabel>();
  for (const entry of entries) {
    const name = entry.type === "tool" ? toolPresentationName(entry) : "thinking";
    const active = activityEntryActive(entry);
    const existing = labels.get(name);
    if (!existing) {
      labels.set(name, { name, active });
    } else if (active && !existing.active) {
      labels.set(name, { ...existing, active: true });
    }
  }
  return [...labels.values()];
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
