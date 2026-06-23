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
});

describe("stripContentFromWireFrame (websocket delta path)", () => {
	test("strips content from function_call_output and reasoning, keeps messages", async () => {
		const { stripContentFromWireFrame } = await import("../src/codex-reasoning-fix/index.js");

		// The exact delta shape observed over the wire that caused input[3].content.
		const frame = {
			type: "response.create",
			model: "gpt-5.5",
			previous_response_id: "resp_1",
			input: [
				{ role: "user", content: [{ type: "input_text", text: "hi" }] },
				{ id: "rs_1", type: "reasoning", content: [], encrypted_content: "e", summary: [] },
				{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }], id: "m1" },
				{ type: "function_call", id: "fc_1", call_id: "c1", name: "read", arguments: "{}" },
				{ type: "function_call_output", call_id: "c1", output: "result", content: [] },
			],
		};

		const cleaned = stripContentFromWireFrame(frame) as any;
		expect(cleaned).toBeDefined();
		expect(cleaned.stripped).toBe(2); // reasoning + function_call_output
		const input = cleaned.frame.input as any[];
		expect(input[0]).toHaveProperty("content"); // user message kept
		expect(input[1]).not.toHaveProperty("content"); // reasoning stripped
		expect(input[2]).toHaveProperty("content"); // type:message kept
		expect(input[3]).not.toHaveProperty("content"); // function_call: had none
		expect(input[4]).not.toHaveProperty("content"); // function_call_output stripped
		expect(cleaned.frame.type).toBe("response.create");
		expect(cleaned.frame.previous_response_id).toBe("resp_1");
		// No stray diagnostic fields leak into the wire frame.
		expect(cleaned.frame.__codexFixStripped).toBeUndefined();
		// Original frame not mutated.
		expect(frame.input[1]).toHaveProperty("content");
		expect(frame.input[4]).toHaveProperty("content");
	});

	test("returns undefined for non-response.create frames", async () => {
		const { stripContentFromWireFrame } = await import("../src/codex-reasoning-fix/index.js");
		expect(stripContentFromWireFrame({ type: "response.cancel" })).toBeUndefined();
		expect(stripContentFromWireFrame({ type: "response.create" })).toBeUndefined(); // no input/messages
		expect(stripContentFromWireFrame(null)).toBeUndefined();
	});

	test("returns undefined when no item needs stripping", async () => {
		const { stripContentFromWireFrame } = await import("../src/codex-reasoning-fix/index.js");
		const frame = { type: "response.create", input: [{ role: "user", content: "hi" }] };
		expect(stripContentFromWireFrame(frame)).toBeUndefined();
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

describe("stripFetchInit (SSE/fetch fallback path)", () => {
	test("strips content from a JSON POST body carrying an `input` array", async () => {
		const { stripFetchInit } = await import("../src/codex-reasoning-fix/index.js");

		// Full-body Codex request as sent over fetch() after a websocket fallback.
		const body = JSON.stringify({
			model: "gpt-5.5",
			input: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
				{ id: "rs_99", type: "reasoning", content: [], encrypted_content: "e" },
				{ type: "function_call_output", call_id: "c1", output: "ok", content: [] },
			],
		});
		const init: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body };

		const next = stripFetchInit(init) as RequestInit;
		expect(next).toBeDefined();
		expect(next).not.toBe(init); // cloned
		const parsed = JSON.parse(next.body as string) as any;
		expect(parsed.input[0]).toHaveProperty("content"); // message kept
		expect(parsed.input[1]).not.toHaveProperty("content"); // reasoning stripped
		expect(parsed.input[2]).not.toHaveProperty("content"); // function_call_output stripped
		expect(next.method).toBe("POST");
		expect(next.headers).toEqual(init.headers);
	});

	test("is a no-op for non-JSON / non-string / clean bodies", async () => {
		const { stripFetchInit } = await import("../src/codex-reasoning-fix/index.js");

		expect(stripFetchInit(undefined)).toBeUndefined();
		expect(stripFetchInit({ method: "POST" })).toBeUndefined(); // no body
		expect(stripFetchInit({ body: "not-json{" })).toBeUndefined(); // unparseable
		expect(stripFetchInit({ body: JSON.stringify({ system: "x" }) })).toBeUndefined(); // no input/messages
		expect(
			stripFetchInit({ body: JSON.stringify({ input: [{ role: "user", content: "hi" }] }) }),
		).toBeUndefined(); // nothing to strip
		// Binary / non-string body left alone.
		expect(stripFetchInit({ body: new Uint8Array([1, 2, 3]) } as any)).toBeUndefined();
	});
});
