import { describe, expect, it } from "bun:test";
import { recordSubagentUsage, subagentUsageFromRpcEvent } from "../src/async-subagents/core/usage.js";

describe("async subagent usage accounting", () => {
	it("extracts provider/model usage from finalized child assistant messages", () => {
		expect(subagentUsageFromRpcEvent({
			type: "message_end",
			message: {
				role: "assistant",
				provider: "openai-codex",
				model: "gpt-5.6-sol",
				usage: {
					input: 100, output: 20, cacheRead: 30, cacheWrite: 4, totalTokens: 154,
					cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.001, total: 0.034 },
				},
			},
		})).toEqual({
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			usage: {
				input: 100, output: 20, cacheRead: 30, cacheWrite: 4, totalTokens: 154,
				cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.001, total: 0.034 },
			},
		});
	});

	it("ignores non-assistant and malformed events", () => {
		expect(subagentUsageFromRpcEvent({ type: "tool_execution_end" })).toBeUndefined();
		expect(subagentUsageFromRpcEvent({ type: "message_end", message: { role: "assistant", provider: "openai", model: "x", usage: {} } })).toBeUndefined();
	});

	it("records usage on the captured parent session manager", () => {
		const calls: unknown[][] = [];
		const manager = {
			appendUsage: (...args: unknown[]) => calls.push(args),
		} as never;
		const event = {
			type: "message_end",
			message: {
				role: "assistant", provider: "anthropic", model: "claude-sonnet",
				usage: {
					input: 80, output: 10, cacheRead: 5, cacheWrite: 0, totalTokens: 95,
					cost: { input: 0.008, output: 0.01, cacheRead: 0.001, cacheWrite: 0, total: 0.019 },
				},
			},
		} as const;
		expect(recordSubagentUsage(manager, event, "agent-7")).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.slice(0, 3)).toEqual(["async-subagent", "anthropic", "claude-sonnet"]);
		expect(calls[0]?.[4]).toBe("agent:agent-7");
	});
});
