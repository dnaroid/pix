import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createPiAiMock } from "./support/pi-ai-mock.js";

// Controllable summarizer result. Each test sets `nextResult` / `nextError`
// (per-call, FIFO) before exercising the code under test.
let nextResults: Array<{ content?: any; error?: unknown; hang?: boolean }> = [];
const completeMock = mock(async (_model: unknown, _input: unknown, _options?: unknown) => {
	const next = nextResults.shift();
	if (next?.hang) return await new Promise(() => {});
	if (next?.error) throw next.error;
	return { content: next?.content ?? [{ type: "text", text: "model summary" }] };
});

// Install the pi-ai mock at module-eval time so a later dynamic import of the
// suite resolves `complete` against the mock.
const piAiMock = createPiAiMock({ complete: completeMock });
mock.module("@earendil-works/pi-ai", () => piAiMock);
mock.module("@earendil-works/pi-ai/compat", () => piAiMock);

function textMessage(role: string, text: string, timestamp: number) {
	return { role, content: [{ type: "text", text }], timestamp };
}

function makeRegistry(opts: {
	findModel?: boolean;
	authOk?: boolean;
	authError?: boolean;
	apiKey?: string;
	customResult?: { content: Array<{ type: string; text: string }> };
	contextWindow?: number;
	maxTokens?: number;
} = {}): any {
	const {
		findModel = true, authOk = true, authError = false, apiKey = "key", customResult,
		contextWindow, maxTokens,
	} = opts;
	return {
		find: (_provider: string, _id: string) =>
			findModel ? ({ provider: _provider, id: _id, contextWindow, maxTokens } as any) : undefined,
		getApiKeyAndHeaders: async (_model: unknown) => {
			if (authError) throw new Error("auth boom");
			return { ok: authOk, apiKey: authOk ? apiKey : undefined, headers: {}, env: { AWS_PROFILE: "pi" } };
		},
		getRegisteredProviderConfig: () => customResult
			? { streamSimple: () => ({ result: async () => customResult }) }
			: undefined,
	};
}

function makeConfig(modelRefs: string[]) {
	return {
		enabled: true,
		debug: false,
		compress: {
			minContextPercent: 0.4,
			maxContextPercent: 0.65,
			autoCompress: {
				enabled: true,
				patience: 2,
				summarizerModel: modelRefs,
				timeoutMs: 1000,
			},
		},
	} as any;
}

async function loadModule() {
	return await import("../src/dcp/auto-compress.js");
}

describe("summary source manifest + extractive fallback", () => {
	test("preserves tool linkage and arguments-only facts while redacting credentials", async () => {
		const { buildSummarySourceManifest } = await loadModule();
		const manifest = buildSummarySourceManifest([
			{
				role: "assistant",
				timestamp: 1,
				content: [{
					type: "toolCall",
					id: "call-args-only",
					name: "shell",
					input: {
						command: "bun test test/payments.test.ts",
						path: "src/payments.ts",
						headers: { Authorization: "Bearer TOP_SECRET" },
						apiKey: "sk-secret-value",
						password: "dont-leak-me",
					},
				}],
			},
			{
				role: "toolResult",
				toolCallId: "call-args-only",
				toolName: "shell",
				isError: false,
				details: { exitCode: 0 },
				content: [{ type: "text", text: "2 tests passed" }],
				timestamp: 2,
			},
		]);

		const rendered = JSON.stringify(manifest);
		expect(rendered).toContain("call-args-only");
		expect(rendered).toContain("bun test test/payments.test.ts");
		expect(rendered).toContain("src/payments.ts");
		expect(rendered).toContain('"outcome":"success"');
		expect(rendered).toContain('"exitCode":0');
		expect(rendered).toContain("[redacted]");
		expect(rendered).not.toContain("TOP_SECRET");
		expect(rendered).not.toContain("sk-secret-value");
		expect(rendered).not.toContain("dont-leak-me");
	});

	test("extractive fallback retains explicit decision, verification failure, next step, and tool args", async () => {
		const { buildExtractiveSummary, buildSummarySourceManifest } = await loadModule();
		const manifest = buildSummarySourceManifest([
			textMessage("user", "Constraint: do not change the database schema.", 1),
			textMessage("assistant", "Decision: keep the current schema. Tests failed with ERROR_E409_RETRY_LOOP. Next step: patch src/payments.ts.", 2),
			{
				role: "assistant",
				timestamp: 3,
				content: [{ type: "toolCall", id: "patch-read", name: "read", input: { path: "src/payments.ts" } }],
			},
		]);
		const summary = buildExtractiveSummary(
			"Checkout retry",
			{ startId: "m001", endId: "m003", messageCount: 3, estimatedTokens: 1000, includedBlockIds: [], reason: "test" },
			manifest,
		);

		expect(summary).toContain("do not change the database schema");
		expect(summary).toContain("Decision: keep the current schema");
		expect(summary).toContain("ERROR_E409_RETRY_LOOP");
		expect(summary).toContain("Next step: patch src/payments.ts");
		expect(summary).toContain("patch-read");
		expect(summary).toContain("src/payments.ts");
	});

	test("refuses to split one parallel tool group across a manifest budget boundary", async () => {
		const { buildSummarySourceManifest, partitionSummarySourceManifest } = await loadModule();
		const manifest = buildSummarySourceManifest([
			{ role: "assistant", timestamp: 1, content: [
				{ type: "toolCall", id: "parallel-a", name: "read", input: { path: "a.ts" } },
				{ type: "toolCall", id: "parallel-b", name: "read", input: { path: "b.ts" } },
			] },
			{ role: "toolResult", toolCallId: "parallel-a", toolName: "read", isError: false, content: [{ type: "text", text: "a".repeat(1_000) }], timestamp: 2 },
			{ role: "toolResult", toolCallId: "parallel-b", toolName: "read", isError: false, content: [{ type: "text", text: "b".repeat(1_000) }], timestamp: 3 },
		]);
		const plan = partitionSummarySourceManifest(manifest, 100);

		expect(plan.chunks).toHaveLength(0);
		expect(plan.oversizedGroup?.sourceIds).toEqual(["src-0001", "src-0002", "src-0003"]);
		expect(plan.incompleteToolGroup).toBeUndefined();
	});
});

describe("generateModelSummary", () => {
	beforeEach(() => {
		nextResults = [];
		completeMock.mockClear();
	});

	test("returns model text with usedModelRef + ok attempt on success", async () => {
		const { generateModelSummary } = await loadModule();
		nextResults = [{ content: [{ type: "text", text: "real summary" }] }];
		const result = await generateModelSummary(
			["zai/glm-5.2"],
			makeRegistry(),
			undefined,
			"Earlier work",
			[textMessage("user", "hi", 1)],
			1000,
		);
		expect(result.text).toBe("real summary");
		expect(result.usedModelRef).toBe("zai/glm-5.2");
		expect(result.attempts).toEqual([{ ref: "zai/glm-5.2", outcome: "ok" }]);
	});

	test("sends the summarizer continuation requirements and complete source transcript", async () => {
		const { generateModelSummary } = await loadModule();
		nextResults = [{ content: [{ type: "text", text: "summary" }] }];
		await generateModelSummary(
			["zai/glm-5.2"],
			makeRegistry(),
			undefined,
			"Checkout retry",
			[
				textMessage("user", "USER_INTENT_RAVEN and CONSTRAINT_NO_SCHEMA_CHANGE", 1),
				textMessage("assistant", "ERROR_E409_RETRY_LOOP then NEXT_STEP_PATCH_PAYMENTS_TS", 2),
				{
					role: "assistant", timestamp: 3, content: [{
						type: "toolCall", id: "source-call", name: "shell",
						input: { command: "bun test", path: "src/payments.ts", headers: { Authorization: "Bearer SECRET" } },
					}],
				},
				{
					role: "toolResult", toolCallId: "source-call", toolName: "shell", isError: true,
					details: { exitCode: 1 }, content: [{ type: "text", text: "ERROR_E409_RETRY_LOOP" }], timestamp: 4,
				},
			],
			1000,
		);

		const call = completeMock.mock.calls[0] as unknown as [unknown, { systemPrompt?: string; messages?: Array<{ content?: unknown }> }];
		const request = call[1];
		expect(request.systemPrompt).toContain("preserve user intent");
		expect(request.systemPrompt).toContain("files/symbols changed or inspected");
		expect(request.systemPrompt).toContain("exact errors still actionable");
		expect(request.systemPrompt).toContain("verification status, and next steps");
		expect(request.systemPrompt).toContain("explicit continuity markers verbatim");
		expect(request.systemPrompt).toContain("uppercase labels before colons");
		expect(request.systemPrompt).toContain("Do not infer, invent, or add facts absent from the source");
		expect(request.systemPrompt).toContain("Drop full logs, repeated output");
		const transcript = String(request.messages?.[0]?.content ?? "");
		expect(transcript).toContain("topic: Checkout retry");
		expect(transcript).toContain("USER_INTENT_RAVEN");
		expect(transcript).toContain("CONSTRAINT_NO_SCHEMA_CHANGE");
		expect(transcript).toContain("ERROR_E409_RETRY_LOOP");
		expect(transcript).toContain("NEXT_STEP_PATCH_PAYMENTS_TS");
		expect(transcript).toContain("source-call");
		expect(transcript).toContain("bun test");
		expect(transcript).toContain("src/payments.ts");
		expect(transcript).toContain("outcome=error");
		expect(transcript).toContain("exit_code=1");
		expect(transcript).toContain("[redacted]");
		expect(transcript).not.toContain("Bearer SECRET");
	});

	test("records empty outcome and returns no text when the model yields nothing", async () => {
		const { generateModelSummary } = await loadModule();
		nextResults = [{ content: [{ type: "text", text: "  " }] }];
		const result = await generateModelSummary(
			["zai/glm-5.2"],
			makeRegistry(),
			undefined,
			"Earlier work",
			[textMessage("user", "hi", 1)],
			1000,
		);
		expect(result.text).toBeUndefined();
		expect(result.attempts).toEqual([{ ref: "zai/glm-5.2", outcome: "empty" }]);
	});

	test("records error outcome and falls through to the next model in the fallback list", async () => {
		const { generateModelSummary } = await loadModule();
		nextResults = [{ error: new Error("timeout") }, { content: [{ type: "text", text: "fallback ok" }] }];
		const result = await generateModelSummary(
			["zai/glm-5.2", "zai/glm-4.5-air"],
			makeRegistry(),
			undefined,
			"Earlier work",
			[textMessage("user", "hi", 1)],
			1000,
		);
		expect(result.text).toBe("fallback ok");
		expect(result.usedModelRef).toBe("zai/glm-4.5-air");
		expect(result.attempts).toEqual([
			{ ref: "zai/glm-5.2", outcome: "error", error: "timeout" },
			{ ref: "zai/glm-4.5-air", outcome: "ok" },
		]);
	});

	test("records no-auth outcome when the registry rejects auth", async () => {
		const { generateModelSummary } = await loadModule();
		const result = await generateModelSummary(
			["zai/glm-5.2"],
			makeRegistry({ authOk: false }),
			undefined,
			"Earlier work",
			[textMessage("user", "hi", 1)],
			1000,
		);
		expect(result.text).toBeUndefined();
		expect(result.attempts).toEqual([{ ref: "zai/glm-5.2", outcome: "no-auth" }]);
		expect(completeMock).not.toHaveBeenCalled();
	});

	test("supports successful auth supplied only through provider environment", async () => {
		const { generateModelSummary } = await loadModule();
		nextResults = [{ content: [{ type: "text", text: "env summary" }] }];
		const result = await generateModelSummary(
			["amazon-bedrock/claude"],
			makeRegistry({ apiKey: "" }),
			undefined,
			"Environment auth",
			[textMessage("user", "hi", 1)],
			1000,
		);

		expect(result.text).toBe("env summary");
		const options = completeMock.mock.calls[0]?.[2] as { apiKey?: string; env?: Record<string, string> };
		expect(options.apiKey).toBe("");
		expect(options.env).toEqual({ AWS_PROFILE: "pi" });
	});

	test("uses an extension provider stream instead of the global compat registry", async () => {
		const { generateModelSummary } = await loadModule();
		const result = await generateModelSummary(
			["antigravity/gemini-3-pro"],
			makeRegistry({ customResult: { content: [{ type: "text", text: "custom summary" }] } }),
			undefined,
			"Custom provider",
			[textMessage("user", "hi", 1)],
			1000,
		);

		expect(result.text).toBe("custom summary");
		expect(completeMock).not.toHaveBeenCalled();
	});

	test("chunks large sources on complete tool groups and merges every chunk", async () => {
		const { generateModelSummary } = await loadModule();
		nextResults = [
			{ content: [{ type: "text", text: "chunk one summary" }] },
			{ content: [{ type: "text", text: "chunk two summary" }] },
			{ content: [{ type: "text", text: "merged summary" }] },
		];
		const messages = [
			{ role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "chunk-a", name: "read", input: { path: "a.ts" } }] },
			{ role: "toolResult", toolCallId: "chunk-a", toolName: "read", isError: false, content: [{ type: "text", text: "a".repeat(3_500) }], timestamp: 2 },
			{ role: "assistant", timestamp: 3, content: [{ type: "toolCall", id: "chunk-b", name: "read", input: { path: "b.ts" } }] },
			{ role: "toolResult", toolCallId: "chunk-b", toolName: "read", isError: false, content: [{ type: "text", text: "b".repeat(3_500) }], timestamp: 4 },
		];
		const result = await generateModelSummary(
			["zai/small-window"],
			makeRegistry({ contextWindow: 3_000, maxTokens: 500 }),
			undefined,
			"Chunked source",
			messages,
			1000,
		);

		expect(result.text).toBe("merged summary");
		expect(result.attempts).toEqual([{ ref: "zai/small-window", outcome: "ok" }]);
		expect(completeMock).toHaveBeenCalledTimes(3);
		const firstPrompt = String((completeMock.mock.calls[0]?.[1] as any)?.messages?.[0]?.content ?? "");
		const secondPrompt = String((completeMock.mock.calls[1]?.[1] as any)?.messages?.[0]?.content ?? "");
		const mergePrompt = String((completeMock.mock.calls[2]?.[1] as any)?.messages?.[0]?.content ?? "");
		expect(firstPrompt).toContain("chunk-a");
		expect(firstPrompt).not.toContain("chunk-b");
		expect(secondPrompt).toContain("chunk-b");
		expect(mergePrompt).toContain("src-0001..src-0002");
		expect(mergePrompt).toContain("src-0003..src-0004");
		expect(mergePrompt).toContain("chunk one summary");
		expect(mergePrompt).toContain("chunk two summary");
	});

	test("bounds hanging auth with the total summarizer operation deadline", async () => {
		const { generateModelSummary } = await loadModule();
		const registry = {
			find: (provider: string, id: string) => ({ provider, id }),
			getApiKeyAndHeaders: () => new Promise(() => {}),
		};
		const started = Date.now();
		const result = await generateModelSummary(
			["zai/glm-5.2"],
			registry as any,
			undefined,
			"Hanging auth",
			[textMessage("user", "continue", 1)],
			25,
		);
		const elapsed = Date.now() - started;

		expect(result.text).toBeUndefined();
		expect(result.attempts).toHaveLength(1);
		expect(result.attempts[0]?.outcome).toBe("no-auth");
		expect(result.attempts[0]?.error).toContain("deadline exceeded");
		expect(elapsed).toBeLessThan(500);
	});

	test("bounds a completion that ignores AbortSignal with the same total deadline", async () => {
		const { generateModelSummary } = await loadModule();
		nextResults = [{ hang: true }];
		const started = Date.now();
		const result = await generateModelSummary(
			["zai/glm-5.2"],
			makeRegistry(),
			undefined,
			"Ignored abort",
			[textMessage("user", "continue", 1)],
			25,
		);
		const elapsed = Date.now() - started;

		expect(result.text).toBeUndefined();
		expect(result.attempts).toHaveLength(1);
		expect(result.attempts[0]?.outcome).toBe("error");
		expect(result.attempts[0]?.error).toMatch(/deadline exceeded|aborted/);
		expect(elapsed).toBeLessThan(500);
	});

	test("records no-model outcome when the registry cannot resolve the model", async () => {
		const { generateModelSummary } = await loadModule();
		const result = await generateModelSummary(
			["zai/glm-5.2"],
			makeRegistry({ findModel: false }),
			undefined,
			"Earlier work",
			[textMessage("user", "hi", 1)],
			1000,
		);
		expect(result.text).toBeUndefined();
		expect(result.attempts).toEqual([{ ref: "zai/glm-5.2", outcome: "no-model" }]);
	});

	test("returns empty attempts when no summarizer models are configured", async () => {
		const { generateModelSummary } = await loadModule();
		const result = await generateModelSummary(
			[],
			makeRegistry(),
			undefined,
			"Earlier work",
			[textMessage("user", "hi", 1)],
			1000,
		);
		expect(result.text).toBeUndefined();
		expect(result.attempts).toEqual([]);
		expect(completeMock).not.toHaveBeenCalled();
	});
});

describe("createAutoCompressionBlock summaryMode + debug fields", () => {
	beforeEach(() => {
		nextResults = [];
		completeMock.mockClear();
	});

	function seedState(state: any) {
		state.messageIdSnapshot.set("m001", 1000);
		state.messageIdSnapshot.set("m002", 2000);
		state.messageMetaSnapshot.set("m001", {
			timestamp: 1000, stableId: "id:start", role: "user", blockId: undefined,
			text: "", tokenEstimate: 100, priority: "medium",
		});
		state.messageMetaSnapshot.set("m002", {
			timestamp: 2000, stableId: "id:end", role: "assistant", blockId: undefined,
			text: "", tokenEstimate: 100, priority: "medium",
		});
	}

	const candidate: any = {
		startId: "m001", endId: "m002", messageCount: 2, estimatedTokens: 1000,
		includedBlockIds: [], reason: "test",
	};

	async function loadState() {
		const { createState } = await import("../src/dcp/state.js");
		return createState();
	}

	test("programmatic mode (by design) when summarizerModel is empty", async () => {
		const { createAutoCompressionBlock } = await loadModule();
		const state = await loadState();
		seedState(state);
		const result = await createAutoCompressionBlock({
			candidate, topic: "Earlier work", state,
			config: makeConfig([]),
			messages: [textMessage("user", "a".repeat(4_000), 1000), textMessage("assistant", "b".repeat(4_000), 2000)],
		});
		expect(result.summaryMode).toBe("programmatic");
		expect(result.summaryRepresentation).toBe("extractive");
		expect(result.sourceHash).toMatch(/^[0-9a-f]{64}$/);
		expect(result.sourceCoverage.itemCount).toBe(2);
		expect(state.compressionBlocks[0]?.autoSummaryRepresentation).toBe("extractive");
		expect(state.compressionBlocks[0]?.sourceHash).toBe(result.sourceHash);
		expect(state.compressionBlocks[0]?.sourceCoverage).toEqual(result.sourceCoverage);
		expect(result.summarizerModelRef).toBeUndefined();
		expect(result.summarizerAttempts).toBeUndefined();
		expect(completeMock).not.toHaveBeenCalled();
	});

	test("model mode when the summarizer succeeds", async () => {
		const { createAutoCompressionBlock } = await loadModule();
		const state = await loadState();
		seedState(state);
		nextResults = [{ content: [{ type: "text", text: "llm digest" }] }];
		const result = await createAutoCompressionBlock({
			candidate, topic: "Earlier work", state,
			config: makeConfig(["zai/glm-5.2", "zai/glm-4.5-air"]),
			messages: [textMessage("user", "a".repeat(4_000), 1000), textMessage("assistant", "b".repeat(4_000), 2000)],
			modelRegistry: makeRegistry(),
		});
		expect(result.summaryMode).toBe("model");
		expect(result.summaryRepresentation).toBe("model");
		expect(result.summarizerModelRef).toBe("zai/glm-5.2");
		expect(result.summarizerAttempts).toEqual([{ ref: "zai/glm-5.2", outcome: "ok" }]);
		expect(state.compressionBlocks[0]?.summary).toBe("llm digest");
	});

	test("programmatic_fallback mode with attempts when every model fails", async () => {
		const { createAutoCompressionBlock } = await loadModule();
		const state = await loadState();
		seedState(state);
		nextResults = [
			{ error: new Error("rate limited") },
			{ content: [{ type: "text", text: "" }] },
		];
		const result = await createAutoCompressionBlock({
			candidate, topic: "Earlier work", state,
			config: makeConfig(["zai/glm-5.2", "zai/glm-4.5-air"]),
			messages: [textMessage("user", "a".repeat(4_000), 1000), textMessage("assistant", "b".repeat(4_000), 2000)],
			modelRegistry: makeRegistry(),
		});
		expect(result.summaryMode).toBe("programmatic_fallback");
		expect(result.summaryRepresentation).toBe("extractive-fallback");
		expect(result.summarizerModelRef).toBeUndefined();
		expect(result.summarizerAttempts).toEqual([
			{ ref: "zai/glm-5.2", outcome: "error", error: "rate limited" },
			{ ref: "zai/glm-4.5-air", outcome: "empty" },
		]);
		// The extractive floor is applied when it still yields positive projected gain.
		expect(result.blockId).toBeGreaterThan(0);
		expect(state.compressionBlocks[0]?.summary).toContain("Earlier work");
	});
});
