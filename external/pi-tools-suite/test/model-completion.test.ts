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
});
