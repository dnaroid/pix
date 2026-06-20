import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createPiAiMock } from "./support/pi-ai-mock.js";

// Controllable summarizer result. Each test sets `nextResult` / `nextError`
// (per-call, FIFO) before exercising the code under test.
let nextResults: Array<{ content?: any; error?: unknown }> = [];
const completeMock = mock(async (_model: unknown, _input: unknown) => {
	const next = nextResults.shift();
	if (next?.error) throw next.error;
	return { content: next?.content ?? [{ type: "text", text: "model summary" }] };
});

// Install the pi-ai mock at module-eval time so a later dynamic import of the
// suite resolves `complete` against the mock.
mock.module("@earendil-works/pi-ai", () =>
	createPiAiMock({
		complete: completeMock,
	}),
);

function textMessage(role: string, text: string, timestamp: number) {
	return { role, content: [{ type: "text", text }], timestamp };
}

function makeRegistry(opts: {
	findModel?: boolean;
	authOk?: boolean;
	authError?: boolean;
} = {}) {
	const { findModel = true, authOk = true, authError = false } = opts;
	return {
		find: (_provider: string, _id: string) =>
			findModel ? ({ provider: _provider, id: _id } as any) : undefined,
		getApiKeyAndHeaders: async (_model: unknown) => {
			if (authError) throw new Error("auth boom");
			return { ok: authOk, apiKey: authOk ? "key" : undefined, headers: {}, env: {} };
		},
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
			messages: [textMessage("user", "a".repeat(200), 1000), textMessage("assistant", "b".repeat(200), 2000)],
		});
		expect(result.summaryMode).toBe("programmatic");
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
			messages: [textMessage("user", "a".repeat(200), 1000), textMessage("assistant", "b".repeat(200), 2000)],
			modelRegistry: makeRegistry(),
		});
		expect(result.summaryMode).toBe("model");
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
			messages: [textMessage("user", "a".repeat(200), 1000), textMessage("assistant", "b".repeat(200), 2000)],
			modelRegistry: makeRegistry(),
		});
		expect(result.summaryMode).toBe("programmatic_fallback");
		expect(result.summarizerModelRef).toBeUndefined();
		expect(result.summarizerAttempts).toEqual([
			{ ref: "zai/glm-5.2", outcome: "error", error: "rate limited" },
			{ ref: "zai/glm-4.5-air", outcome: "empty" },
		]);
		// Floor summary still applied so a block is always produced.
		expect(result.blockId).toBeGreaterThan(0);
		expect(state.compressionBlocks[0]?.summary).toContain("Earlier work");
	});
});
