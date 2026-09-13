import type { ToolCallStatus } from "@agentclientprotocol/sdk";
import type {
  MessageItem,
  ToolGroupItem,
  ToolItem,
  TranscriptDisplayItem,
  TranscriptItem,
} from "./transcript-types";

export function groupTranscriptItems(items: readonly TranscriptItem[]): TranscriptDisplayItem[] {
  const grouped: TranscriptDisplayItem[] = [];

  for (const item of items) {
    if (item.type === "message") {
      grouped.push(messageForDisplay(item));
      continue;
    }

    const previous = grouped.at(-1);
    if (previous?.type === "tool-group") {
      const tools: [ToolItem, ...ToolItem[]] = [...previous.tools, item];
      grouped[grouped.length - 1] = buildToolGroup(tools);
    } else {
      grouped.push(buildToolGroup([item]));
    }
  }

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

function buildToolGroup(tools: readonly [ToolItem, ...ToolItem[]]): ToolGroupItem {
  const active = tools.some((tool) => tool.status === "pending" || tool.status === "in_progress");
  let status: ToolCallStatus = "completed";
  if (tools.some((tool) => tool.status === "failed")) {
    status = "failed";
  } else if (tools.some((tool) => tool.status === "in_progress")) {
    status = "in_progress";
  } else if (tools.some((tool) => tool.status === "pending")) {
    status = "pending";
  }
  let earliestStart: number | undefined;
  let latestEnd: number | undefined;
  for (const tool of tools) {
    if (tool.startedAtMs !== undefined) {
      earliestStart = earliestStart === undefined ? tool.startedAtMs : Math.min(earliestStart, tool.startedAtMs);
    }
    if (tool.endedAtMs !== undefined) {
      latestEnd = latestEnd === undefined ? tool.endedAtMs : Math.max(latestEnd, tool.endedAtMs);
    }
  }
  const durationMs = !active && earliestStart !== undefined && latestEnd !== undefined
    ? Math.max(0, latestEnd - earliestStart)
    : undefined;

  return {
    type: "tool-group",
    id: `tool-group:${tools[0].toolCallId}`,
    tools,
    status,
    active,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
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
