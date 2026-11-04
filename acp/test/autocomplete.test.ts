import assert from "node:assert/strict";
import { test } from "node:test";
import { RequestError } from "@agentclientprotocol/sdk";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PiAgentMessage } from "../src/pi/pi-rpc-client.js";
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
		fallbackModels: [],
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
		fallbackModels: [],
		debounceMs: 900,
		timeoutMs: 8_000,
		maxTokens: 128,
		maxPromptTokens: 4_000,
		includeRecentMessages: 7,
	};
	assert.deepEqual(autocompleteConfigFromParsed({ autoComplete: " provider/model " }, fallback), {
		modelRef: "provider/model",
		fallbackModels: [],
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
		fallbackModels: [],
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
			fallbackModels: [],
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
	assert.match(context?.systemPrompt ?? "", /text predictor for inline autocomplete/u);
	assert.match(context?.systemPrompt ?? "", /one message currently being typed by the human user/u);
	assert.match(context?.systemPrompt ?? "", /Never switch to the assistant\/agent's voice/u);
	assert.match(context?.messages?.[0]?.content ?? "", /Use the safe API\./u);
	assert.match(context?.messages?.[0]?.content ?? "", /Do not answer the draft or start a new conversation turn/u);
	assert.match(context?.messages?.[0]?.content ?? "", /<draft>\nimplement\n<cursor>/u);
});

test("the production completer turns the explicit empty sentinel into no suggestion", async () => {
	const runtime = {
		getModel: (provider: string, modelId: string) => ({ provider, id: modelId, maxTokens: 4_096 }),
		refresh: async () => {},
		streamSimple: () => (async function* () {
			yield { type: "text_delta", delta: "<EMPTY>" };
		})(),
	} as unknown as ModelRuntime;
	const complete = createAutocompleteCompleter({
		logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		loadConfig: () => ({
			modelRef: "zai/glm-5-turbo",
			fallbackModels: [],
			debounceMs: 350,
			timeoutMs: 1_250,
			maxTokens: 48,
			maxPromptTokens: 1_200,
			includeRecentMessages: 0,
		}),
		createModelRuntime: async () => runtime,
	});

	assert.equal(await complete({
		cwd: "/tmp/project",
		draft: "проверь промпт",
		signal: new AbortController().signal,
		getMessages: async () => [],
	}), "");
});

function nextMessageFixture(maxPromptTokens = 1_200, output = "Добавь тесты") {
	let prompt = "";
	let runtimeCalls = 0;
	const runtime = {
		getModel: () => ({ provider: "test", id: "model", maxTokens: 4_096 }),
		streamSimple: (_model: unknown, context: { messages: Array<{ content: string }> }) => {
			prompt = context.messages[0]!.content;
			return (async function* () { yield { type: "text_delta", delta: output }; })();
		},
	} as unknown as ModelRuntime;
	const complete = createAutocompleteCompleter({
		logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		loadConfig: () => ({
			modelRef: "test/model", fallbackModels: [], debounceMs: 350, timeoutMs: 1_250,
			maxTokens: 48, maxPromptTokens, includeRecentMessages: 0,
		}),
		createModelRuntime: async () => { runtimeCalls++; return runtime; },
	});
	return { complete, get prompt() { return prompt; }, get runtimeCalls() { return runtimeCalls; } };
}

test("empty drafts predict the next user message with bounded history even with prefix history disabled", async () => {
	const fixture = nextMessageFixture();
	const messages: PiAgentMessage[] = Array.from({ length: 8 }, (_, index) => ({
		role: index % 2 === 0 ? "user" : "assistant",
		content: [{ type: "text", text: `message-${index}` }],
	}));
	assert.equal(await fixture.complete({
		cwd: "/tmp/project", draft: "", signal: new AbortController().signal,
		getMessages: async () => messages,
	}), "Добавь тесты");
	assert.match(fixture.prompt, /Predict the human user's next message/u);
	assert.match(fixture.prompt, /<draft>\n\n<cursor>/u);
	assert.doesNotMatch(fixture.prompt, /message-[01]/u);
	assert.match(fixture.prompt, /message-2/u);
	assert.match(fixture.prompt, /message-7/u);
});

test("empty drafts do not initialize a model without usable user context or prompt budget", async () => {
	for (const messages of [[], [{ role: "assistant", content: [{ type: "text", text: "Welcome" }] }]]) {
		const fixture = nextMessageFixture();
		assert.equal(await fixture.complete({
			cwd: "/tmp/project", draft: "", signal: new AbortController().signal,
			getMessages: async () => messages,
		}), "");
		assert.equal(fixture.runtimeCalls, 0);
	}
	const fixture = nextMessageFixture(256);
	assert.equal(await fixture.complete({
		cwd: "/tmp/project", draft: "", signal: new AbortController().signal,
		getMessages: async () => [{ role: "user", content: [{ type: "text", text: "Fix the bug" }] }],
	}), "");
	assert.equal(fixture.runtimeCalls, 0);
});

test("empty-draft history failure and cancellation do not start generation", async () => {
	const fixture = nextMessageFixture();
	assert.equal(await fixture.complete({
		cwd: "/tmp/project", draft: "", signal: new AbortController().signal,
		getMessages: async () => { throw new Error("unavailable"); },
	}), "");
	const controller = new AbortController();
	const pending = fixture.complete({
		cwd: "/tmp/project", draft: "", signal: controller.signal,
		getMessages: () => new Promise(() => {}),
	});
	controller.abort();
	await assert.rejects(pending);
	assert.equal(fixture.runtimeCalls, 0);
});

test("next-message uncertainty returns no suggestion and short drafts still skip generation", async () => {
	const fixture = nextMessageFixture(1_200, "<EMPTY>");
	assert.equal(await fixture.complete({
		cwd: "/tmp/project", draft: "", signal: new AbortController().signal,
		getMessages: async () => [{ role: "user", content: [{ type: "text", text: "Fix the bug" }] }],
	}), "");
	for (const draft of [" ", "ab", "/help", "!pwd"]) {
		const skipped = nextMessageFixture();
		assert.equal(await skipped.complete({
			cwd: "/tmp/project", draft, signal: new AbortController().signal,
			getMessages: async () => { throw new Error("should not load history"); },
		}), "");
		assert.equal(skipped.runtimeCalls, 0);
	}
});
