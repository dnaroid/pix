import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import quotaWait from "../src/bundled-extensions/quota-wait/index.js";
import type { QuotaCheck } from "../src/app/session/quota-wait.js";

function fixture(query: () => Promise<QuotaCheck> = async () => ({ kind: "unknown" }), branch: unknown[] = []) {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const entries: any[] = []; const messages: any[] = []; const events: any[] = [];
	const controls: string[] = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
	let continuable = false;
	let aborts = 0;
	const ctx = { mode: "rpc", hasUI: true, model: { provider: "unsupported", id: "model" }, thinkingLevel: "off",
		sessionManager: { getBranch: () => branch, getSessionId: () => "session-1" }, isIdle: () => true,
		abort: () => { aborts++; }, ui: { setWidget(key: string, lines: string[] | undefined) { widgets.push({ key, lines }); }, setStatus(key: string, text: string | undefined) { statuses.push({ key, text }); }, notify() {} },
	} as unknown as ExtensionContext;
	quotaWait({ on: (name: string, fn: any) => { handlers.set(name, fn); }, registerCommand: (name: string, command: any) => commands.set(name, command.handler),
		appendEntry: (type: string, data: any) => entries.push({ type: "custom", customType: type, data }),
		sendMessage: (message: any) => {
			if (message.customType === "pix-quota-control") {
				controls.push(message.details.action);
				message.details.accepted();
				message.details.settle(message.details.action === "pause" || continuable);
			} else messages.push(message);
		}, events: { emit: (channel: string, data: any) => events.push({ channel, data }) },
	} as unknown as ExtensionAPI, query);
	return { ctx, entries, messages, events, controls, statuses, widgets, setContinuable: (value: boolean) => { continuable = value; }, get aborts() { return aborts; },
		emit: async (name: string, event: any = {}) => await handlers.get(name)?.(event, ctx),
		command: async (args: string) => await commands.get("wait")!(args, ctx),
		state: () => entries.at(-1)?.data.state,
	};
}
const error = (errorMessage: string) => ({ messages: [{ role: "assistant", stopReason: "error", errorMessage }] });
const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };

describe("quota wait bundled extension", () => {
	it("pushes terminal Claude rejection on the private rate-limit channel without quota I/O", async () => {
		let queries = 0;
		const f = fixture(async () => { queries++; return { kind: "unknown" }; });
		Object.assign(f.ctx, { model: { provider: "pi-claude-code-provider", id: "opus" } });
		await f.emit("session_start");
		const now = Date.now();
		const reset = new Date(now + 3600_000);
		const hour = reset.getUTCHours();
		const clock = `${hour % 12 || 12}:${String(reset.getUTCMinutes()).padStart(2, "0")}${hour >= 12 ? "pm" : "am"}`;
		const message = { role: "assistant", provider: "pi-claude-code-provider", model: "opus", stopReason: "error", timestamp: now,
			errorMessage: `Claude Code request failed (429): You've hit your session limit · resets ${clock} (UTC)` };
		await f.emit("message_end", { message });
		const sample = f.events.find((event) => event.channel === "pix:claude-code:rate-limit")?.data;
		assert.equal(sample?.status, "rejected");
		assert.equal(sample?.sessionId, "session-1");
		assert.equal(sample?.resetsAt, Math.floor(reset.getTime() / 60_000) * 60_000);
		assert.deepEqual(f.widgets.find((widget) => widget.lines?.[0] === "pix:claude-code:rate-limit")?.lines,
			["pix:claude-code:rate-limit", JSON.stringify(sample)]);
		assert.equal(queries, 0);
		const count = f.events.length;
		await f.emit("message_end", { message: { ...message, model: "sonnet" } });
		await f.emit("message_end", { message: { ...message, timestamp: 0 } });
		await f.emit("session_shutdown");
		await f.emit("message_end", { message });
		assert.equal(f.events.length, count);
	});
	it("publishes only a compact /wait footer label and clears it on shutdown", async () => {
		const f = fixture(); await f.emit("session_start");
		await f.command("1h20m");
		assert.match(f.statuses.at(-1)?.text ?? "", /1h20m · \/wait$/u);
		assert.equal(f.statuses.at(-1)?.key, "quota-wait");
		await f.emit("session_shutdown");
		assert.deepEqual(f.statuses.at(-1), { key: "quota-wait", text: undefined });
	});
	it("schedules an absolute time without changing its timestamp", async () => {
		const f = fixture(); await f.emit("session_start");
		try {
			const deadline = Date.now() + 3_600_000;
			await f.command(`until ${new Date(deadline).toISOString()}`);
			assert.equal(f.state().notBefore, deadline);
			assert.equal(f.state().nextCheckAt, deadline);
			assert.deepEqual(f.controls, ["pause"]);
		} finally { await f.emit("session_shutdown"); }
	});
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
	it("manual duration on a paused session uses Continue without adding a transcript message", async () => {
		const f = fixture(); f.setContinuable(true); await f.emit("session_start");
		try {
			const before = Date.now(); await f.command("1h20m");
			assert.deepEqual(f.controls, ["pause"]);
			assert.equal(f.state().mode, "timer");
			assert.ok(f.state().notBefore >= before + 4_800_000);
			assert.equal(f.messages.length, 0);
			await f.command("retry"); await flush();
			assert.deepEqual(f.controls, ["pause", "continue"]);
			assert.equal(f.messages.length, 0);
			await f.emit("agent_start");
			assert.equal(f.state().phase, "resuming");
			await f.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
			assert.equal(f.state(), null);
		} finally { await f.emit("session_shutdown"); }
	});
	it("usage-reset schedules a quota check, invalid duration leaves state untouched", async () => {
		const f = fixture(); await f.emit("session_start");
		try {
			await f.command("usage-reset"); assert.equal(f.state().mode, "quota");
			const saved = f.state(); await f.command("tomorrow"); assert.equal(f.state(), saved);
			await f.command("cancel"); assert.equal(f.state().autoResume, false);
		} finally { await f.emit("session_shutdown"); }
	});
	it("direct Continue and explicit Stop supersede a manual timer", async () => {
		const f = fixture(); await f.emit("session_start");
		try {
			await f.command("1h"); await f.emit("agent_start"); assert.equal(f.state(), null);
			await f.command("1h");
			const abort = new AbortController(); abort.abort(); Object.assign(f.ctx, { signal: abort.signal });
			await f.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
			assert.equal(f.state(), null);
		} finally { await f.emit("session_shutdown"); }
	});
	it("new input and model selection invalidate an in-flight exhaustion query", async () => {
		for (const name of ["input", "model_select"]) {
			let resolve!: (value: QuotaCheck) => void;
			const f = fixture(() => new Promise((done) => { resolve = done; })); await f.emit("session_start");
			const pending = f.emit("agent_end", error("usage_limit_reached"));
			await f.emit(name); resolve({ kind: "exhausted", window: "weekly" }); await pending;
			assert.equal(f.state(), null); assert.equal(f.aborts, 0);
			await f.emit("session_shutdown");
		}
	});
});
