import type { DesktopSessionSubagentUsage as SessionSubagentUsage, DesktopSessionSubagentUsageReport as SessionSubagentUsageReport } from "../../../acp/src/acp/desktop-commands";
import type { SessionUsageTotals } from "./acp-client-types";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = (): never => { throw new Error("invalid Pix subagent usage"); };

export function parseSubagentUsageReport(value: unknown, totals: (value: unknown) => SessionUsageTotals): SessionSubagentUsageReport {
  if (!record(value) || !Array.isArray(value.agents)) return invalid();
  let changes: SessionSubagentUsageReport["changes"];
  if (value.changes !== undefined) {
    if (!record(value.changes) || !Array.isArray(value.changes.files) || !Array.isArray(value.changes.gaps)
      || !value.changes.gaps.every((gap) => typeof gap === "string")) return invalid();
    changes = {
      files: value.changes.files.map((file) => {
        if (!record(file) || typeof file.path !== "string" || !file.path.trim()
          || !["write", "edit", "create", "delete", "move", "modify"].includes(String(file.operation))
          || (file.previousPath !== undefined && typeof file.previousPath !== "string")) return invalid();
        return { path: file.path, operation: file.operation as NonNullable<SessionSubagentUsageReport["changes"]>["files"][number]["operation"],
          ...(typeof file.previousPath === "string" ? { previousPath: file.previousPath } : {}) };
      }),
      gaps: value.changes.gaps as string[],
    };
  }
  return {
    ...(changes ? { changes } : {}),
    main: totals(value.main), other: totals(value.other), totals: totals(value.totals), unattributed: totals(value.unattributed),
    agents: value.agents.map((value): SessionSubagentUsage => {
      if (!record(value) || typeof value.key !== "string" || typeof value.agentId !== "string" || typeof value.usageRecorded !== "boolean" || !Array.isArray(value.models)) return invalid();
      const labels: Partial<SessionSubagentUsage> = {};
      for (const field of ["runDir", "task", "scope", "subagentType", "icon", "configuredModel", "status"] as const) {
        if (value[field] !== undefined) {
          if (typeof value[field] !== "string") return invalid();
          labels[field] = value[field];
        }
      }
      if (value.tools !== undefined && !Array.isArray(value.tools)) return invalid();
      return {
        ...labels, key: value.key, agentId: value.agentId, usageRecorded: value.usageRecorded, totals: totals(value.totals),
        models: value.models.map((model) => {
          if (!record(model) || typeof model.provider !== "string" || typeof model.model !== "string") return invalid();
          return { provider: model.provider, model: model.model, totals: totals(model.totals) };
        }),
        ...(Array.isArray(value.tools) ? { tools: value.tools.map((tool) => {
          if (!record(tool) || typeof tool.name !== "string" || typeof tool.count !== "number" || !Number.isSafeInteger(tool.count) || tool.count < 1) return invalid();
          return { name: tool.name, count: tool.count };
        }) } : {}),
      };
    }),
  };
}
