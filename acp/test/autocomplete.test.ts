import assert from "node:assert/strict";
import { test } from "node:test";
import { RequestError } from "@agentclientprotocol/sdk";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	autocompleteConfigFromParsed,
	autocompleteSettings,
	createAutocompleteCompleter,
	parseAutocompleteRequest,
	parseAutocompleteSettingsRequest,
} from "../src/acp/autocomplete.js";

test("parseAutocompleteRequest accepts the private ACP request shape", () => {
	assert.deepEqual(
		parseAutocompleteRequest({ sessionId: "session-1", draft: "finish this" }),
		{ sessionId: "session-1", draft: "finish this" },
	);
});

test("parseAutocompleteRequest rejects malformed params", () => {
	assert.throws(
		() => parseAutocompleteRequest({ sessionId: "session-1", draft: 42 }),
		(error: unknown) => error instanceof RequestError && error.code === -32602,
	);
});

test("autocomplete settings expose only client scheduling details", () => {
	assert.deepEqual(autocompleteSettings({
		modelRef: "zai/glm-5-turbo",
		debounceMs: 410,
		timeoutMs: 3_000,
		maxTokens: 48,
		maxPromptTokens: 1_200,
		includeRecentMessages: 0,
	}), { enabled: true, debounceMs: 410 });
	assert.deepEqual(parseAutocompleteSettingsRequest({ sessionId: "session-1" }), {
		sessionId: "session-1",
	});
});

test("desktop config parsing matches canonical autocomplete aliases and defaults", () => {
	const fallback = {
		modelRef: "global/custom",
		debounceMs: 900,
		timeoutMs: 8_000,
		maxTokens: 128,
		maxPromptTokens: 4_000,
		includeRecentMessages: 7,
	};
	assert.deepEqual(autocompleteConfigFromParsed({ autoComplete: " provider/model " }, fallback), {
		modelRef: "provider/model",
		debounceMs: 350,
		timeoutMs: 3_000,
		maxTokens: 48,
		maxPromptTokens: 1_200,
		includeRecentMessages: 0,
	});
	assert.deepEqual(autocompleteConfigFromParsed({
		autocomplete: { model: "", debounceMs: 0, recentMessages: 3 },
	}, fallback), {
		modelRef: "",
		debounceMs: 100,
		timeoutMs: 3_000,
		maxTokens: 48,
		maxPromptTokens: 1_200,
		includeRecentMessages: 3,
	});
	assert.equal(autocompleteConfigFromParsed({}, fallback), fallback);
});

test("the production completer streams a non-session suffix with TUI limits", async () => {
	let captured: { model: Record<string, unknown>; context: Record<string, unknown>; options: Record<string, unknown> } | undefined;
	const runtime = {
		getModel: (provider: string, modelId: string) => ({ provider, id: modelId, maxTokens: 4_096 }),
		refresh: async () => {},
		streamSimple: (
			model: Record<string, unknown>,
			context: Record<string, unknown>,
			options: Record<string, unknown>,
		) => {
			captured = { model, context, options };
			return (async function* () {
				yield { type: "text_delta", delta: "implement safely" };
			})();
		},
	} as unknown as ModelRuntime;
	const complete = createAutocompleteCompleter({
		logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		loadConfig: () => ({
			modelRef: "zai/glm-5-turbo:low",
			debounceMs: 350,
			timeoutMs: 1_250,
			maxTokens: 48,
			maxPromptTokens: 1_200,
			includeRecentMessages: 1,
		}),
		createModelRuntime: async () => runtime,
	});

	const completion = await complete({
		cwd: "/tmp/project",
		draft: "implement",
		signal: new AbortController().signal,
		getMessages: async () => [
			{ role: "assistant", content: [{ type: "text", text: "Use the safe API." }] },
		],
	});

	assert.equal(completion, " safely");
	assert.equal(captured?.model.maxTokens, 48);
	assert.deepEqual(captured?.options, {
		signal: captured.options.signal,
		reasoning: "low",
		cacheRetention: "none",
		maxRetryDelayMs: 0,
		maxRetries: 0,
		maxTokens: 48,
		timeoutMs: 1_250,
	});
	const context = captured?.context as { systemPrompt?: string; messages?: Array<{ content?: string }> } | undefined;
	assert.match(context?.systemPrompt ?? "", /inline autocomplete engine/u);
	assert.match(context?.messages?.[0]?.content ?? "", /Use the safe API\./u);
	assert.match(context?.messages?.[0]?.content ?? "", /<draft>\nimplement\n<cursor>/u);
});
