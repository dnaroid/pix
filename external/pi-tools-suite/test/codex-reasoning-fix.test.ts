import { describe, expect, test } from "bun:test";
import register, { stripReasoningContentFromPayload } from "../src/codex-reasoning-fix/index.js";
import { MODULES } from "../src/index.js";

const codex = { api: "openai-codex-responses", provider: "custom", id: "anything" };
const direct = { api: "openai-responses", provider: "another", id: "also-anything" };

describe("codex-reasoning-fix", () => {
	test("registers last within the suite only", () => {
		expect(MODULES.at(-1)?.name).toBe("codex-reasoning-fix");
	});

	test("removes only null and empty-array content on exact reasoning items, without mutation", () => {
		for (const model of [codex, direct]) {
			const input = [
				{ type: "reasoning", content: null, id: "rs_a", encrypted_content: "cipher" },
				{ type: "reasoning", content: [], id: "rs_b", summary: [{ type: "summary_text", text: "thought" }] },
				{ type: "reasoning", content: [{ type: "text", text: "keep" }] },
				{ type: "reasoning", content: "malformed but preserved" },
				{ type: "reasoning", content: {} },
				{ type: "reasoning", content: 0 },
				{ type: "reasoning", content: undefined },
				{ type: "reasoning", id: "no-content" },
				{ type: "function_call_output", content: null, output: "ok" },
				{ type: "unknown", content: [] },
				{ type: "message", content: [] },
				{ role: "user", content: null },
			];
			const payload = { input, prompt_cache_retention: "24h", other: { nested: true } };
			const result = stripReasoningContentFromPayload(payload, model) as typeof payload;
			expect(result).not.toBe(payload);
			expect(result.input).not.toBe(input);
			expect(result.input[0]).toEqual({ type: "reasoning", id: "rs_a", encrypted_content: "cipher" });
			expect(result.input[1]).toEqual({ type: "reasoning", id: "rs_b", summary: input[1].summary });
			expect(input[0]).toHaveProperty("content", null);
			expect(input[1]).toHaveProperty("content", []);
			for (let i = 2; i < input.length; i++) expect(result.input[i]).toBe(input[i]);
			expect(result.other).toBe(payload.other);
			expect(result.prompt_cache_retention).toBe("24h");
		}
	});

	test("leaves unrelated APIs, invalid carriers, and no-op payloads identical", () => {
		const payload = { input: [{ type: "reasoning", content: null }], messages: [{ type: "reasoning", content: [] }] };
		for (const model of [undefined, null, "openai-codex-responses", { api: "anthropic-messages", provider: "openai-codex" }, { api: "OPENAI-RESPONSES" }]) {
			expect(stripReasoningContentFromPayload(payload, model)).toBe(payload);
		}
		for (const carrier of [null, "bad", { messages: payload.input }, { input: null }, { input: {} }, { input: [{ type: "reasoning", content: [1] }] }]) {
			expect(stripReasoningContentFromPayload(carrier, codex)).toBe(carrier);
		}
		const empty = { ...payload, input: [] };
		expect(stripReasoningContentFromPayload(empty, codex)).toBe(empty);
	});

	test("handler reads selected model API from context, returns undefined on no-op", () => {
		let handler: (event: any, ctx: any) => unknown = () => { throw new Error("not registered"); };
		register({ on(name: string, fn: typeof handler) { expect(name).toBe("before_provider_request"); handler = fn; } });
		const payload = { model: "openai-codex/gpt-5.4", input: [{ type: "reasoning", content: [] }], prompt_cache_retention: "24h" };
		expect(handler({ payload }, { model: { api: "other", provider: "openai-codex" } })).toBeUndefined();
		const result = handler({ payload }, { model: direct }) as typeof payload;
		expect(result.input[0]).toEqual({ type: "reasoning" });
		expect(result.prompt_cache_retention).toBe("24h");
		expect(payload.input[0].content).toEqual([]);
	});
});
