import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/dcp/config.js";
import { registerCompressTool } from "../src/dcp/compress-tool.js";
import { applyPruning } from "../src/dcp/pruner.js";
import { createState } from "../src/dcp/state.js";

function text(id: string, role: string, timestamp: number, value: string): any {
	return { id, role, timestamp, content: [{ type: "text", text: value }] };
}

function fixture() {
	const config = loadConfig({ homeDir: "/__dcp_manual_summary_no_config__" });
	config.debug = false;
	config.compress.autoCompress = {
		enabled: false,
		patience: 2,
		summarizerModel: ["fixture/cheap"],
		timeoutMs: 250,
	};
	return { config, state: createState() };
}

function registerTool(state: ReturnType<typeof createState>, config: ReturnType<typeof loadConfig>) {
	let tool: any;
	registerCompressTool({ registerTool(value: any) { tool = value; } } as any, state, config);
	return tool;
}

function cheapRegistry(summary: string, onComplete?: (context: unknown) => void) {
	let calls = 0;
	return {
		get calls() { return calls; },
		find(provider: string, id: string) {
			return {
				provider,
				id,
				api: "openai-completions",
				contextWindow: 32_000,
				maxTokens: 2_000,
			};
		},
		async getApiKeyAndHeaders() { return { ok: true as const }; },
		async complete(_model: unknown, context: unknown) {
			calls += 1;
			onComplete?.(context);
			return { content: [{ type: "text", text: summary }], stopReason: "stop" };
		},
	};
}

function context(modelRegistry?: unknown): any {
	return { sessionManager: {}, ui: { notify() {} }, modelRegistry };
}

describe("DCP explicit/manual cheap summarizer", () => {
	test("omitted range summary uses configured cheap model even when auto firing is disabled", async () => {
		const { state, config } = fixture();
		const raw = [
			text("old-user", "user", 1, "USER_GOAL_KEEP_API " + "u".repeat(3_000)),
			text("old-work", "assistant", 2, "DECISION_KEEP_RETRY_KEY " + "a".repeat(5_000)),
			text("current", "user", 3, "continue"),
		];
		applyPruning(raw, state, config);
		const startId = state.messageIdsByStableId.get("id:old-user")!;
		const endId = state.messageIdsByStableId.get("id:old-work")!;
		let captured = "";
		const registry = cheapRegistry(
			"CHEAP_RANGE_SUMMARY USER_GOAL_KEEP_API DECISION_KEEP_RETRY_KEY",
			(value) => { captured = JSON.stringify(value); },
		);

		const result = await registerTool(state, config).execute(
			"manual-cheap-range",
			{
				topic: "Old retry work",
				ranges: [{
					startId,
					endId,
				}],
			},
			undefined,
			undefined,
			context(registry),
		);

		expect(registry.calls).toBe(1);
		expect(captured).toContain("USER_GOAL_KEEP_API");
		expect(captured).toContain("DECISION_KEEP_RETRY_KEY");
		expect(state.compressionBlocks[0]?.summary).toContain("CHEAP_RANGE_SUMMARY");
		expect(result.details.summaryPreparations).toEqual([
			expect.objectContaining({
				selection: `${startId}..${endId}`,
				mode: "model",
				summarizerModelRef: "fixture/cheap",
			}),
		]);
		expect(result.details.netGain).toBeGreaterThan(0);
	});

	test("omitted message summary uses the same cheap summarizer path", async () => {
		const { state, config } = fixture();
		const raw = [
			text("request", "user", 1, "inspect the large result"),
			{
				id: "call",
				role: "assistant",
				timestamp: 2,
				content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/a.ts" } }],
			},
			{
				id: "result",
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				isError: false,
				timestamp: 3,
				content: [{ type: "text", text: "IMPORTANT_RESULT_FACT " + "r".repeat(8_000) }],
			},
			text("current", "user", 4, "continue"),
		];
		applyPruning(raw, state, config);
		const messageId = [...state.messageMetaSnapshot.entries()]
			.find(([, meta]) => meta.toolCallId === "read-1")?.[0];
		expect(messageId).toBeDefined();
		const registry = cheapRegistry("CHEAP_MESSAGE_SUMMARY IMPORTANT_RESULT_FACT");

		const result = await registerTool(state, config).execute(
			"manual-cheap-message",
			{ topic: "Large read", messages: [{ messageId }] },
			undefined,
			undefined,
			context(registry),
		);

		expect(registry.calls).toBe(1);
		expect(state.compressionBlocks[0]?.replacementMode).toBe("message-body");
		expect(state.compressionBlocks[0]?.summary).toContain("CHEAP_MESSAGE_SUMMARY");
		expect(result.details.summaryPreparations[0]).toMatchObject({
			selection: messageId,
			mode: "model",
		});
	});

	test("explicit summary bypasses the summarizer completely", async () => {
		const { state, config } = fixture();
		const raw = [
			text("old-a", "assistant", 1, "a".repeat(4_000)),
			text("old-b", "assistant", 2, "b".repeat(4_000)),
			text("current", "user", 3, "continue"),
		];
		applyPruning(raw, state, config);
		const registry = cheapRegistry("MUST_NOT_BE_USED");
		const startId = state.messageIdsByStableId.get("id:old-a")!;
		const endId = state.messageIdsByStableId.get("id:old-b")!;

		const result = await registerTool(state, config).execute(
			"manual-explicit-summary",
			{
				topic: "Explicit",
				ranges: [{ startId, endId, summary: "PARENT_AUTHORED_SUMMARY" }],
			},
			undefined,
			undefined,
			context(registry),
		);

		expect(registry.calls).toBe(0);
		expect(state.compressionBlocks[0]?.summary).toContain("PARENT_AUTHORED_SUMMARY");
		expect(result.details.summaryPreparations[0]).toMatchObject({ mode: "explicit" });
	});

	test("an explicitly empty summary remains explicit for backward compatibility", async () => {
		const { state, config } = fixture();
		const raw = [
			text("old-a", "assistant", 1, "a".repeat(4_000)),
			text("old-b", "assistant", 2, "b".repeat(4_000)),
			text("current", "user", 3, "continue"),
		];
		applyPruning(raw, state, config);
		const registry = cheapRegistry("MUST_NOT_BE_USED");
		const startId = state.messageIdsByStableId.get("id:old-a")!;
		const endId = state.messageIdsByStableId.get("id:old-b")!;

		const result = await registerTool(state, config).execute(
			"manual-explicit-empty-summary",
			{ topic: "Explicit empty", ranges: [{ startId, endId, summary: "" }] },
			undefined,
			undefined,
			context(registry),
		);

		expect(registry.calls).toBe(0);
		expect(result.details.summaryPreparations[0]).toMatchObject({ mode: "explicit" });
	});

	test("unavailable or timed-out cheap model falls back to extractive continuation", async () => {
		for (const mode of ["missing", "timeout"] as const) {
			const { state, config } = fixture();
			config.compress.autoCompress.timeoutMs = 15;
			const raw = [
				text(
					"old-a",
					"assistant",
					1,
					"Decision: KEEP_FALLBACK_FACT\n" + "ordinary inspection output\n".repeat(1_400),
				),
				text(
					"old-b",
					"assistant",
					2,
					"Next step: RUN_FALLBACK_TEST\n" + "ordinary verification output\n".repeat(1_400),
				),
				text("current", "user", 3, "continue"),
			];
			applyPruning(raw, state, config);
			const startId = state.messageIdsByStableId.get("id:old-a")!;
			const endId = state.messageIdsByStableId.get("id:old-b")!;
			const registry = mode === "missing"
				? { find: () => undefined, async getApiKeyAndHeaders() { return { ok: false as const, error: "missing" }; } }
				: {
					find: (provider: string, id: string) => ({ provider, id, api: "openai-completions", contextWindow: 32_000, maxTokens: 2_000 }),
					getApiKeyAndHeaders: () => new Promise(() => {}),
				};

			const result = await registerTool(state, config).execute(
				`manual-fallback-${mode}`,
				{ topic: "Fallback", ranges: [{ startId, endId }] },
				undefined,
				undefined,
				context(registry),
			);

			expect(result.details.summaryPreparations[0]).toMatchObject({ mode: "extractive-fallback" });
			expect(state.compressionBlocks[0]?.summary).toContain("KEEP_FALLBACK_FACT");
			expect(state.compressionBlocks[0]?.summary).toContain("RUN_FALLBACK_TEST");
		}
	});

	test("parent abort during delegated summary never commits", async () => {
		const { state, config } = fixture();
		config.compress.autoCompress.timeoutMs = 1_000;
		const raw = [
			text("old-a", "assistant", 1, "a".repeat(5_000)),
			text("old-b", "assistant", 2, "b".repeat(5_000)),
			text("current", "user", 3, "continue"),
		];
		applyPruning(raw, state, config);
		const startId = state.messageIdsByStableId.get("id:old-a")!;
		const endId = state.messageIdsByStableId.get("id:old-b")!;
		const controller = new AbortController();
		const registry = {
			find: (provider: string, id: string) => ({ provider, id, api: "openai-completions", contextWindow: 32_000, maxTokens: 2_000 }),
			async getApiKeyAndHeaders() { return { ok: true as const }; },
			complete: () => new Promise(() => {}),
		};
		setTimeout(() => controller.abort(new Error("parent cancelled")), 10);

		await expect(registerTool(state, config).execute(
			"manual-abort",
			{ topic: "Abort", ranges: [{ startId, endId }] },
			controller.signal,
			undefined,
			context(registry),
		)).rejects.toThrow();
		expect(state.compressionBlocks).toHaveLength(0);
		expect(state.nextBlockId).toBe(1);
	});

	test("verified source change during summarizer await is rejected atomically", async () => {
		const { state, config } = fixture();
		const raw = [
			text("old-a", "assistant", 1, "a".repeat(5_000)),
			text("old-b", "assistant", 2, "b".repeat(5_000)),
			text("current", "user", 3, "continue"),
		];
		applyPruning(raw, state, config);
		const startId = state.messageIdsByStableId.get("id:old-a")!;
		const endId = state.messageIdsByStableId.get("id:old-b")!;
		const registry = cheapRegistry("STALE_SUMMARY", () => {
			state.conversationIndexSnapshot[0]!.contentHash = "0".repeat(64);
		});

		await expect(registerTool(state, config).execute(
			"manual-stale-source",
			{ topic: "Stale", ranges: [{ startId, endId }] },
			undefined,
			undefined,
			context(registry),
		)).rejects.toThrow(/provider projection|stale_plan/i);
		expect(state.compressionBlocks).toHaveLength(0);
		expect(state.nextBlockId).toBe(1);
	});
});
