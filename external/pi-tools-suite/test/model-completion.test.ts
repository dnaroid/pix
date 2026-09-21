import { describe, expect, test } from "bun:test";

import { completeWithModelRegistry } from "../src/model-completion.js";

describe("model completion", () => {
	test("dispatches through ModelRegistry.complete with nullable headers intact", async () => {
		const model = { provider: "custom", id: "test-model", baseUrl: "https://catalog.invalid" } as any;
		const context = { messages: [] } as any;
		const options = { headers: { "X-Keep": "value", "X-Delete": null } } as any;
		let registeredProviderLookup = false;
		const expected = { content: [{ type: "text", text: "ok" }] } as any;

		const result = await completeWithModelRegistry(
			{
				async complete(receivedModel, receivedContext, receivedOptions) {
					expect(receivedModel).toBe(model);
					expect(receivedContext).toBe(context);
					expect(receivedOptions).toBe(options);
					expect(receivedOptions?.headers?.["X-Delete"]).toBeNull();
					return expected;
				},
				getRegisteredProviderConfig() {
					registeredProviderLookup = true;
					return undefined;
				},
			},
			model,
			context,
			options,
		);

		expect(result).toBe(expected);
		expect(registeredProviderLookup).toBeFalse();
	});

	test("normalizes Context before invoking a legacy custom provider stream", async () => {
		const model = { provider: "custom", id: "test-model" } as any;
		const context = { systemPrompt: "Follow instructions", tools: [{ name: "lookup" }], messages: [] } as any;
		const expected = { content: [{ type: "text", text: "ok" }] } as any;

		const result = await completeWithModelRegistry(
			{
				getRegisteredProviderConfig() {
					return {
						streamSimple(_model: unknown, receivedContext: any) {
							expect(receivedContext.systemPrompt).toBeUndefined();
							expect(receivedContext.tools).toBeUndefined();
							expect(receivedContext.messages).toHaveLength(1);
							expect(receivedContext.messages[0]).toMatchObject({
								role: "system",
								content: "Follow instructions",
								toolsAdded: context.tools,
							});
							return { result: async () => expected };
						},
					};
				},
			},
			model,
			context,
		);

		expect(result).toBe(expected);
	});
});
