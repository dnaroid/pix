import { describe, expect, test } from "bun:test";
// The installed package does not export these internal converters publicly.
import { convertResponsesMessages } from "../../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js";
import { stream as streamOpenAIResponses } from "../../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js";
import { normalizeContext } from "../../../node_modules/@earendil-works/pi-ai/dist/utils/transcript.js";
import { stripReasoningContentFromPayload } from "../src/codex-reasoning-fix/index.js";

const model = {
	api: "openai-codex-responses", provider: "openai-codex", id: "gpt-5.4",
	reasoning: true, input: ["text"],
} as any;

function replay(content: unknown, selectedModel = model): any[] {
	const stored = { type: "reasoning", id: "rs_old", content, encrypted_content: "cipher", summary: [] };
	return convertResponsesMessages(selectedModel, normalizeContext({ messages: [{
		role: "assistant", provider: model.provider, api: model.api, model: model.id,
		stopReason: "stop", timestamp: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		content: [{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(stored) }],
	}] }), new Set([model.provider])) as any[];
}

describe("installed pi-ai replay and request boundaries", () => {
	test("legacy persisted signatures roundtrip through real converter and narrow wire sanitizer", () => {
		for (const content of [null, []]) {
			const converted = replay(content);
			expect(converted[0].content).toEqual(content);
			const payload = { input: converted, prompt_cache_retention: "24h" };
			const wire = stripReasoningContentFromPayload(payload, model) as typeof payload;
			expect(wire.input[0]).toEqual({ type: "reasoning", id: "rs_old", encrypted_content: "cipher", summary: [] });
			expect(converted[0].content).toEqual(content);
			expect(wire.prompt_cache_retention).toBe("24h");
		}
		const nonempty = replay([{ type: "reasoning_text", text: "original" }]);
		const payload = { input: nonempty };
		expect(stripReasoningContentFromPayload(payload, model)).toBe(payload);
	});

	test("converter drops empty thinking on identity switch; sanitizer relies on API not provider name", () => {
		for (const selected of [{ ...model, id: "different" }, { ...model, provider: "proxy" }, { ...model, api: "openai-responses" }]) {
			expect(replay(null, selected)).toEqual([]);
		}
		const input = replay(null);
		expect(stripReasoningContentFromPayload({ input }, { ...model, provider: "proxy" })).not.toEqual({ input });
	});

	test("real OpenAI Responses builder retains custom compat legacy cache field (no backend request)", async () => {
		const direct = {
			...model, api: "openai-responses", provider: "openai", id: "gpt-5.6",
			baseUrl: "https://invalid.example.test/v1", compat: { supportsLongCacheRetention: true, supportsExplicitPromptCacheMode: false },
		};
		let seen: any;
		const stream = streamOpenAIResponses(direct, { messages: [{ role: "user", content: "hello" }] } as any, {
			apiKey: "offline-test-key", cacheRetention: "long", sessionId: "offline-test",
			fetch: () => { throw new Error("unexpected backend request"); },
			onPayload: (payload: unknown) => {
				seen = stripReasoningContentFromPayload(payload, direct);
				throw new Error("stop before transport");
			},
		} as any);
		for await (const _event of stream) { /* drain expected stopped stream */ }
		expect(seen.prompt_cache_retention).toBe("24h");
	});

	test("cached WS continuation mismatch remains: unsanitized converted response forces full-context fallback", () => {
		// Mirrors installed openai-codex-responses.js getCachedWebSocketInputDelta /
		// buildCachedWebSocketRequestBody: JSON stringify body-minus-input match,
		// then prefix of current input equals lastRequestBody.input + lastResponseItems.
		const previous = { model: model.id, input: [{ role: "user", content: "first" }] };
		for (const content of [null, []]) {
			const rawResponse = replay(content);
			const lastRequestBody = stripReasoningContentFromPayload(previous, model) as typeof previous;
			const current = stripReasoningContentFromPayload({ model: model.id, input: [...previous.input, ...rawResponse, { role: "user", content: "next" }] }, model) as any;
			const baseline = [...lastRequestBody.input, ...rawResponse]; // converter's unsanitized lastResponseItems
			const prefix = current.input.slice(0, baseline.length);
			expect(prefix).not.toEqual(baseline);
			// SDK returns undefined on prefix mismatch, clears continuation, sends full body.
			const delta = JSON.stringify(prefix) === JSON.stringify(baseline) ? current.input.slice(baseline.length) : undefined;
			expect(delta).toBeUndefined();
			expect(current.input).toHaveLength(3);
			expect(current.input[1]).not.toHaveProperty("content");
			expect(rawResponse[0]).toHaveProperty("content", content);
			// Without wire normalization, the same converter baseline permits a delta.
			const rawCurrent = [...previous.input, ...rawResponse, { role: "user", content: "next" }];
			expect(JSON.stringify(rawCurrent.slice(0, baseline.length))).toBe(JSON.stringify(baseline));
			expect(rawCurrent.slice(baseline.length)).toEqual([{ role: "user", content: "next" }]);
		}
	});
});
