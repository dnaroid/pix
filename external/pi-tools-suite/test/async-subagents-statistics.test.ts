import { describe, expect, it } from "bun:test";
import { recordSubagentTaskStatistics, recordSubagentToolStatistics, recordSubagentStateStatistics } from "../src/async-subagents/core/statistics.js";
import { recordSubagentUsage } from "../src/async-subagents/core/usage.js";

describe("durable subagent statistics", () => {
	it("records only tool starts, task preview and terminal status on the captured owner", () => {
		const parentEntries: unknown[][] = [];
		const nextEntries: unknown[][] = [];
		let active = { appendCustomEntry: (...args: unknown[]) => parentEntries.push(args) };
		const captured = active;
		const onEvent = (event: { type: string; toolName?: string }) => recordSubagentToolStatistics(captured, event, "/one", "worker");
		expect(recordSubagentTaskStatistics(captured, "/one", { id: "worker", task: "Review", subagentType: "research", model: "test/model", icon: "Search" })).toBe(true);
		active = { appendCustomEntry: (...args: unknown[]) => nextEntries.push(args) };
		expect(onEvent({ type: "tool_execution_start", toolName: "read" })).toBe(true);
		expect(onEvent({ type: "tool_execution_end", toolName: "read" })).toBe(false);
		expect(onEvent({ type: "tool_execution_start", toolName: " " })).toBe(false);
		expect(recordSubagentStateStatistics(captured, "/one", "worker", "done")).toBe(true);
		expect(parentEntries).toHaveLength(3);
		expect(parentEntries[0]).toEqual(["pi-tools-suite:subagent-statistics", { version: 1, event: "task", runDir: "/one", id: "worker", task: "Review", subagentType: "research", model: "test/model", icon: "Search" }]);
		expect(parentEntries[1]?.[1]).toEqual({ version: 1, event: "tool", runDir: "/one", id: "worker", toolName: "read" });
		expect(parentEntries[2]?.[1]).toEqual({ version: 1, event: "state", runDir: "/one", id: "worker", status: "done" });
		expect(nextEntries).toHaveLength(0);
		expect(active).not.toBe(captured);
	});
	it("degrades safely for older managers or optional telemetry write failures", () => {
		expect(recordSubagentTaskStatistics(undefined, "/one", { id: "x", task: "Test" })).toBe(false);
		expect(recordSubagentTaskStatistics(null, "/one", { id: "x", task: "Test" })).toBe(false);
		expect(recordSubagentTaskStatistics({}, "/one", { id: "x", task: "Test" })).toBe(false);
		expect(recordSubagentStateStatistics({ get appendCustomEntry() { throw new Error("unavailable"); } }, "/one", "x", "failed")).toBe(false);
		expect(recordSubagentToolStatistics({ appendCustomEntry: () => { throw new Error("unavailable"); } }, { type: "tool_execution_start", toolName: "read" }, "/one", "x")).toBe(false);
	});
	it("stores a versioned run identity for billing without changing kind or amounts", () => {
		const entries: unknown[][] = [];
		const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const manager = { appendUsage: (...args: unknown[]) => entries.push(args) };
		expect(recordSubagentUsage(manager, { type: "message_end", message: { role: "assistant", provider: "p", model: "m", usage } }, "worker", "/one")).toBe(true);
		expect(entries[0]?.slice(0, 4)).toEqual(["async-subagent", "p", "m", usage]);
		expect(JSON.parse(String(entries[0]?.[4]))).toEqual({ version: 1, runDir: "/one", agentId: "worker" });
	});
});
