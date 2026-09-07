import { describe, expect, test } from "bun:test";

import { stream as streamOpenAiCompletions } from "@earendil-works/pi-ai/api/openai-completions";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("context gateway P00: installed provider serialization", () => {
	test("OpenAI completions onPayload sees serialized tool content but not tool-result details", async () => {
		const boundedSentinel = "P00_PROVIDER_BOUNDED_CONTENT";
		const rawDetailsSentinel = "P00_PROVIDER_RAW_DETAILS_MUST_NOT_SERIALIZE";
		let capturedPayload: unknown;
		const model = {
			id: "p00-openai-completions",
			name: "P00 OpenAI completions",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "http://127.0.0.1:1/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4_096,
		} as any;
		const context = {
			systemPrompt: "",
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "provider-call-1", name: "contract_tool", arguments: {} }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: ZERO_USAGE,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: "provider-call-1",
					toolName: "contract_tool",
					content: [{ type: "text", text: boundedSentinel }],
					details: { raw: rawDetailsSentinel },
					isError: false,
					timestamp: Date.now(),
				},
			],
			tools: [],
		} as any;

		const response = streamOpenAiCompletions(model, context, {
			apiKey: "p00-offline-test-key",
			maxRetries: 0,
			onPayload(payload) {
				capturedPayload = structuredClone(payload);
				throw new Error("P00_STOP_AFTER_PROVIDER_SERIALIZATION");
			},
		});
		const finalMessage = await response.result();

		expect(capturedPayload).toBeTruthy();
		const serialized = JSON.stringify(capturedPayload);
		expect(serialized).toContain(boundedSentinel);
		expect(serialized).toContain('"tool_call_id":"provider-call-1"');
		expect(serialized).not.toContain(rawDetailsSentinel);
		expect(finalMessage.stopReason).toBe("error");
		expect(finalMessage.errorMessage).toContain("P00_STOP_AFTER_PROVIDER_SERIALIZATION");
	});
});
