import { describe, expect, it } from "vitest";
import { subagentUsageCost, subagentUsageRatio } from "./subagent-usage";
import { parseSessionUsageStatus } from "./acp-response-parsers";

const parseReport = (usage: unknown) => parseSessionUsageStatus({ sessionId: "test-session", usage }).usage;

const totals = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: 0.03 };
const agent = { key: "key", agentId: "worker", totals, usageRecorded: true, models: [{ provider: "p", model: "m", totals }] };
const base = { totals, unattributed: totals, providers: [] };
const subagents = { main: totals, other: totals, totals, unattributed: totals, agents: [agent] };

describe("subagent usage presentation and protocol", () => {
  it("shows tokens and cost relative to main including >100%, zero and absent denominator", () => {
    expect(subagentUsageRatio(300, 100)).toBe("300%");
    expect(subagentUsageRatio(0, 100)).toBe("0%");
    expect(subagentUsageRatio(1, 0)).toBe("—");
    expect(subagentUsageRatio(1, 10_000)).toBe("<0.1%");
    expect(subagentUsageRatio(1, 3)).toBe("33.3%");
    expect(subagentUsageCost({ ...totals, costEstimated: true })).toBe("~$0.03");
  });
  it("accepts old runtime reports, preserves estimates and distinguishes unknown/empty tools", () => {
    expect(parseReport(base).subagents).toBeUndefined();
    const parsed = parseReport({ ...base, subagents: { ...subagents, agents: [agent, { ...agent, key: "empty", tools: [], totals: { ...totals, costEstimated: true } }] } });
    expect(parsed.subagents!.agents[0]!.tools).toBeUndefined();
    expect(parsed.subagents!.agents[1]!.tools).toEqual([]);
    expect(parsed.subagents!.agents[1]!.totals.costEstimated).toBe(true);
  });
  it.each([
    null, {}, { ...subagents, agents: [null] }, { ...subagents, main: { ...totals, cost: -1 } },
    ...[0, -1, 1.5, Infinity, "2"].map((count) => ({ ...subagents, agents: [{ ...agent, tools: [{ name: "read", count }] }] })),
    { ...subagents, agents: [{ ...agent, task: 2 }] }, { ...subagents, agents: [{ ...agent, usageRecorded: "yes" }] },
  ])("rejects malformed subagent payloads", (value) => {
    expect(() => parseReport({ ...base, subagents: value })).toThrow();
  });
  it("accepts optional child file changes and rejects malformed entries", () => {
    const changes = { files: [{ path: "new.ts", operation: "move", previousPath: "old.ts" }, { path: "gone.ts", operation: "delete" }], gaps: ["shell not tracked"] };
    expect(parseReport({ ...base, subagents: { ...subagents, changes } }).subagents!.changes).toEqual(changes);
    expect(parseReport({ ...base, subagents }).subagents!.changes).toBeUndefined();
    for (const invalid of [null, {}, { files: [null], gaps: [] }, { files: [{ path: "file", operation: "unknown" }], gaps: [] }, { files: [], gaps: [1] }]) {
      expect(() => parseReport({ ...base, subagents: { ...subagents, changes: invalid } })).toThrow();
    }
  });
});
