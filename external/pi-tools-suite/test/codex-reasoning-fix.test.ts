import { describe, expect, mock, test } from "bun:test";
import { createPiAiMock } from "./support/pi-ai-mock.js";
import { createTypeboxMock } from "./support/typebox-mock.js";

mock.module("@earendil-works/pi-ai", () =>
	createPiAiMock({
		Type: {
			Object: (properties: any, options?: any) => ({ kind: "object", properties, options }),
			Optional: (schema: any) => ({ kind: "optional", schema }),
			String: (options?: any) => ({ kind: "string", options }),
			Array: (items: any, options?: any) => ({ kind: "array", items, options }),
			Number: (options?: any) => ({ kind: "number", options }),
			Boolean: (options?: any) => ({ kind: "boolean", options }),
			Record: (key: any, value: any, options?: any) => ({ kind: "record", key, value, options }),
			Unknown: (options?: any) => ({ kind: "unknown", options }),
		},
	}),
);
mock.module("typebox", () => createTypeboxMock());

class FakePi {
	handlers = new Map<string, any>();
	on(name: string, handler: any) { this.handlers.set(name, handler); }
	async emit(name: string, event: any, ctx: any) { return await this.handlers.get(name)?.(event, ctx); }
}

describe("codex-reasoning-fix", () => {
	test("is registered last so no later suite hook can reintroduce invalid content", async () => {
		const { MODULES } = await import("../src/index.js");
		expect(MODULES[MODULES.length - 1]?.name).toBe("codex-reasoning-fix");
		expect(MODULES.findIndex((module) => module.name === "dcp")).toBeLessThan(MODULES.length - 1);
	});

	test("does not monkey-patch global fetch or WebSocket transport", async () => {
		const fetchBefore = globalThis.fetch;
		const sendBefore = globalThis.WebSocket?.prototype.send;
		await import("../src/codex-reasoning-fix/index.js");
		expect(globalThis.fetch).toBe(fetchBefore);
		expect(globalThis.WebSocket?.prototype.send).toBe(sendBefore);
	});

	test("strips content from reasoning items in a Responses `input` payload", async () => {
		const { stripReasoningContentFromPayload } = await import("../src/codex-reasoning-fix/index.js");

		const reasoning = {
			id: "rs_abc",
			type: "reasoning",
			content: [],
			encrypted_content: "gAAA-encrypted",
			summary: [{ type: "summary_text", text: "thought" }],
		};
		const payload = {
			model: "openai-codex/gpt-5.4",
			input: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
				reasoning,
			],
		};

		const result = stripReasoningContentFromPayload(payload) as any;

		expect(result).not.toBe(payload); // cloned when changed
		const input = result.input as any[];
		expect(input).toHaveLength(2);
		expect(input[0]).toBe(payload.input[0]); // non-reasoning untouched (same ref)
		expect(input[1]).not.toHaveProperty("content");
		expect(input[1]).toEqual({
			id: "rs_abc",
			type: "reasoning",
			encrypted_content: "gAAA-encrypted",
			summary: [{ type: "summary_text", text: "thought" }],
		});
		// Original item is not mutated in place.
		expect(reasoning.content).toEqual([]);
	});

	test("leaves reasoning items that already lack content untouched", async () => {
		const { stripReasoningContentFromPayload } = await import("../src/codex-reasoning-fix/index.js");

		const payload = {
			model: "openai-codex/gpt-5.4",
			input: [{ id: "rs_1", type: "reasoning", encrypted_content: "x" }],
		};

		const result = stripReasoningContentFromPayload(payload);
		// Nothing changed -> returns the original reference.
		expect(result).toBe(payload);
	});

	test("is a no-op for non-Responses payloads (system-only / messages / non-record)", async () => {
		const { stripReasoningContentFromPayload } = await import("../src/codex-reasoning-fix/index.js");

		const systemOnly = { system: "prompt", model: "anthropic/x" };
		expect(stripReasoningContentFromPayload(systemOnly)).toBe(systemOnly);

		const chat = { model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }] };
		expect(stripReasoningContentFromPayload(chat)).toBe(chat);

		expect(stripReasoningContentFromPayload(null)).toBeNull();
		expect(stripReasoningContentFromPayload("nope")).toBe("nope");
	});

	test("registers a before_provider_request handler that returns the cleaned payload", async () => {
		const { default: register } = await import("../src/codex-reasoning-fix/index.js");
		const pi = new FakePi();
		register(pi as any);

		const result = await pi.emit(
			"before_provider_request",
			{
				payload: {
					model: "openai-codex/gpt-5.4",
					input: [{ id: "rs_z", type: "reasoning", content: [], encrypted_content: "e" }],
				},
			},
			{},
		);

		expect(result).toBeDefined();
		expect(result.input[0]).not.toHaveProperty("content");
		expect(result.input[0]).toHaveProperty("encrypted_content", "e");
	});

	test("handler returns undefined when nothing needs cleaning", async () => {
		const { default: register } = await import("../src/codex-reasoning-fix/index.js");
		const pi = new FakePi();
		register(pi as any);

		const result = await pi.emit(
			"before_provider_request",
			{ payload: { model: "anthropic/claude", messages: [{ role: "user", content: "hi" }] } },
			{},
		);

		expect(result).toBeUndefined();
	});

	test("final sanitizer removes content introduced by an earlier payload hook", async () => {
		const handlers: any[] = [];
		const pi = { on(name: string, handler: any) { if (name === "before_provider_request") handlers.push(handler); } };
		pi.on("before_provider_request", async (event: any) => ({
			...event.payload,
			input: event.payload.input.map((item: any) => item.type === "function_call_output"
				? { ...item, content: "late metadata" }
				: item),
		}));
		const { default: register } = await import("../src/codex-reasoning-fix/index.js");
		register(pi as any);

		let payload: any = {
			input: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
				{ type: "function_call_output", call_id: "c1", output: "ok" },
			],
		};
		for (const handler of handlers) {
			const result = await handler({ type: "before_provider_request", payload }, {});
			if (result !== undefined) payload = result;
		}

		expect(payload.input[0]).toHaveProperty("content");
		expect(payload.input[1]).not.toHaveProperty("content");
		expect(payload.input[1]).toHaveProperty("output", "ok");
	});
});

describe("stripCarrier (shared core)", () => {
	test("strips content from non-message items in an `input` array", async () => {
		const { stripCarrier } = await import("../src/codex-reasoning-fix/index.js");

		const obj = {
			input: [
				{ role: "user", content: "hi" },
				{ id: "rs_1", type: "reasoning", content: [], encrypted_content: "e" },
				{ type: "function_call_output", call_id: "c1", output: "ok", content: [] },
			],
		};

		const result = stripCarrier(obj) as any;
		expect(result).toBeDefined();
		expect(result.stripped).toBe(2);
		expect(result.obj.input[0]).toHaveProperty("content");
		expect(result.obj.input[1]).not.toHaveProperty("content");
		expect(result.obj.input[2]).not.toHaveProperty("content");
		// Original untouched.
		expect(obj.input[1]).toHaveProperty("content");
	});

	test("returns undefined when nothing needs stripping", async () => {
		const { stripCarrier } = await import("../src/codex-reasoning-fix/index.js");
		expect(stripCarrier({ input: [{ role: "user", content: "hi" }] })).toBeUndefined();
		expect(stripCarrier({ system: "x" })).toBeUndefined();
		expect(stripCarrier(null)).toBeUndefined();
	});
});
