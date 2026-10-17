import { toolPresentationName } from "./tool-presentation";
import type { ToolItem } from "./transcript-types";

export interface SubagentToolTarget {
  readonly runDir: string;
  readonly agentId: string;
}

const MAX_TARGETS = 12;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Sub-agent sessions referenced by a finished `subagents` tool card. Reads the
 * structured result details (spawn/status/wait/stop: `{runDir, agents[]}`;
 * send/result: `{runDir, agentId}`), never the free-form result text.
 */
export function subagentToolTargets(tool: Pick<ToolItem, "kind" | "name" | "title" | "skillName" | "status" | "rawOutput">): SubagentToolTarget[] {
  if (tool.status !== "completed" || toolPresentationName(tool) !== "subagents") return [];
  const details = record(tool.rawOutput);
  const runDir = text(details?.runDir);
  if (!details || !runDir) return [];
  const ids: string[] = [];
  const single = text(details.agentId);
  if (single) ids.push(single);
  if (Array.isArray(details.agents)) {
    for (const agent of details.agents) {
      const id = text(record(agent)?.id);
      if (id) ids.push(id);
    }
  }
  return [...new Set(ids)].slice(0, MAX_TARGETS).map((agentId) => ({ runDir, agentId }));
}
