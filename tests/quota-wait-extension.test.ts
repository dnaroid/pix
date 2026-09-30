import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import quotaWait from "../src/bundled-extensions/quota-wait/index.js";
import type { QuotaCheck } from "../src/app/session/quota-wait.js";

function fixture(query: () => Promise<QuotaCheck> = async () => ({ kind: "unknown" }), branch: unknown[] = []) {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const entries: any[] = []; const messages: any[] = []; const events: any[] = [];
	let aborts = 0;
	const ctx = { mode: "rpc", hasUI: true, model: { provider: "unsupported", id: "model" }, thinkingLevel: "off",
		sessionManager: { getBranch: () => branch, getSessionId: () => "session-1" }, isIdle: () => true,
		abort: () => { aborts++; }, ui: { setWidget() {}, setStatus() {}, notify() {} },
	} as unknown as ExtensionContext;
	quotaWait({ on: (name: string, fn: any) => { handlers.set(name, fn); }, registerCommand: (name: string, command: any) => commands.set(name, command.handler),
		appendEntry: (type: string, data: any) => entries.push({ type: "custom", customType: type, data }),
		sendMessage: (message: any) => messages.push(message), events: { emit: (channel: string, data: any) => events.push({ channel, data }) },
	} as unknown as ExtensionAPI, query);
	return { ctx, entries, messages, events, get aborts() { return aborts; },
		emit: async (name: string, event: any = {}) => await handlers.get(name)?.(event, ctx),
		command: async (args: string) => await commands.get("quota-wait")!(args, ctx),
		state: () => entries.at(-1)?.data.state,
	};
}
const error = (errorMessage: string) => ({ messages: [{ role: "assistant", stopReason: "error", errorMessage }] });
const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };

describe("quota wait bundled extension", () => {
	it("persists exhaustion before settlement, probes once, and clears on successful assistant response", async () => {
		const f = fixture(); await f.emit("session_start");
		try {
			await f.emit("agent_end", error("usage_limit_reached"));
			assert.equal(f.aborts, 1); assert.equal(f.state().phase, "waiting");
			assert.equal(f.events.at(-1).data.sessionId, "session-1");
			await f.emit("agent_settled"); await f.command("retry"); await flush();
			assert.equal(f.messages.length, 1); assert.equal(f.messages[0].display, false);
			await f.emit("message_end", { message: { role: "assistant", stopReason: "toolUse" } });
			assert.equal(f.state(), null);
		} finally { await f.emit("session_shutdown"); }
	});
	it("does not capture network, ordinary 429 or billing errors", async () => {
		let queries = 0;
		const f = fixture(async () => { queries++; return { kind: "available" }; }); await f.emit("session_start");
		try {
			for (const text of ["fetch failed", "503 overloaded", "insufficient_quota", "429 rate limit"]) await f.emit("agent_end", error(text));
			assert.equal(f.aborts, 0); assert.equal(f.state(), null); assert.equal(queries, 1);
		} finally { await f.emit("session_shutdown"); }
	});
	it("generic 429 enters wait only with corroborating subscription window", async () => {
		const f = fixture(async () => ({ kind: "exhausted", window: "weekly", resetAt: Date.now() + 100000 })); await f.emit("session_start");
		try { await f.emit("agent_end", error("429 too many requests")); assert.equal(f.state().window, "weekly"); assert.equal(f.aborts, 1); }
		finally { await f.emit("session_shutdown"); }
	});
	it("restores the latest branch entry and checks before resuming", async () => {
		const first = fixture(); await first.emit("session_start"); await first.emit("agent_end", error("weekly limit exceeded")); await first.emit("session_shutdown");
		const f = fixture(async () => ({ kind: "available" }), first.entries); await f.emit("session_start");
		try { await flush(); assert.equal(f.messages.length, 1); }
		finally { await f.emit("session_shutdown"); }
		const cleared = fixture(async () => ({ kind: "available" }), [...first.entries, { type: "custom", customType: "pix-quota-wait", data: { state: null } }]);
		await cleared.emit("session_start"); await flush(); assert.equal(cleared.messages.length, 0); await cleared.emit("session_shutdown");
	});
	it("does not commit a quota result after shutdown or user abort", async () => {
		for (const shutdown of [true, false]) {
			let resolve!: (value: QuotaCheck) => void;
			const f = fixture(() => new Promise((done) => { resolve = done; })); await f.emit("session_start");
			const abort = new AbortController(); Object.assign(f.ctx, { signal: abort.signal });
			const pending = f.emit("agent_end", error("usage_limit_reached"));
			if (shutdown) await f.emit("session_shutdown"); else abort.abort();
			resolve({ kind: "exhausted", window: "weekly" }); await pending;
			assert.equal(f.aborts, 0); assert.equal(f.state(), null);
			await f.emit("session_shutdown");
		}
	});
	it("explicit new input or model change supersedes waiting", async () => {
		const f = fixture(); await f.emit("session_start");
		try {
			for (const name of ["input", "model_select"]) {
				await f.emit("agent_end", error("usage_limit_reached")); await f.emit(name); assert.equal(f.state(), null);
			}
		} finally { await f.emit("session_shutdown"); }
	});
});
