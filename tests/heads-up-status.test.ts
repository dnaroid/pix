import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import headsUp from "../src/bundled-extensions/heads-up/index.js";
import { DEFAULT_HEADS_UP_CONFIG } from "../src/bundled-extensions/heads-up/config.js";
import { HeadsUpController, type HeadsUpControllerOptions, type HeadsUpRequest } from "../src/bundled-extensions/heads-up/controller.js";
import type { HeadsUpSnapshot } from "../src/bundled-extensions/heads-up/contract.js";

const model = { provider: "openai-codex", id: "gpt-6-luna" } as Model<Api>;
const finding = { kind: "heads_up", notices: [{ id: null, title: "Old clients break", consequence: "The new loader rejects their settings.", evidenceIds: ["u", "t"] }] };
function response(value: unknown = { kind: "none" }): AssistantMessage {
	return {
		role: "assistant", api: "openai-responses", provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0,
		content: [{ type: "text", text: JSON.stringify(value) }],
		usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function harness(options: Partial<HeadsUpControllerOptions> = {}) {
	let now = 0;
	const timers = new Map<symbol, { at: number; callback: () => void }>();
	const requests: HeadsUpRequest[] = [];
	const snapshots: ReturnType<HeadsUpController["snapshot"]>[] = [];
	const controller = new HeadsUpController({
		now: () => now,
		after: (ms, callback) => { const key = Symbol(); timers.set(key, { at: now + ms, callback }); return () => timers.delete(key); },
		findModel: () => model,
		request: async (request) => { requests.push(request); return response(); },
		canAccountUsage: () => true, accountUsage: () => {}, publish: (snapshot) => snapshots.push(snapshot),
		config: { minIntervalMs: 0, minTurns: 1, ...options.config },
		...options,
	});
	controller.context.add({ id: "u", kind: "user", text: "Keep support for existing settings." });
	controller.context.add({ id: "t", kind: "tool", text: "The loader now rejects the old settings." });
	return {
		controller, requests, snapshots,
		advance(ms: number) {
			now += ms;
			for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.callback(); }
		},
	};
}

test("status snapshots are factual reads and completed turns publish cadence progress", () => {
	const h = harness({ config: { minIntervalMs: 60_000 } });
	const initial = h.controller.snapshot();
	assert.deepEqual(initial.details?.config.minIntervalMs, 60_000);
	assert.equal(initial.details?.newTurns, 0);
	assert.equal(initial.details?.intervalEligibleAt, 60_000);
	assert.equal(initial.details?.checksInWindow, 0);
	assert.equal(initial.details?.windowResetsAt, null);
	assert.equal(h.requests.length, 0);
	h.controller.refreshStatus();
	assert.equal(h.requests.length, 0);
	h.controller.setEnabled(true);
	h.controller.noteTurn({ role: "assistant", content: "done" }, "a", [], []);
	assert.equal(h.snapshots.at(-1)?.details?.newTurns, 1);
	assert.equal(h.requests.length, 0);
	h.controller.dispose();
});

test("status records none, notice, duplicate, invalid, and error outcomes with durations", async () => {
	const outcomes: Array<{ reply?: AssistantMessage; reject?: boolean; result: string }> = [
		{ reply: response(), result: "none" },
		{ reply: response(finding), result: "notice" },
		{ reply: response(finding), result: "notice" }, // Existing-card review, not a duplicate delivery.
		{ reply: response(finding), result: "duplicate" },
		{ reply: response({ kind: "none", extra: true }), result: "invalid" },
		{ reject: true, result: "error" },
	];
	let index = 0;
	const h = harness({ request: async () => {
		const outcome = outcomes[index++]!;
		h.advance(25);
		if (outcome.reject) throw new Error("transport failed");
		return outcome.reply!;
	} });
	h.controller.setEnabled(true);
	for (const outcome of outcomes) {
		if (outcome.result === "duplicate") h.controller.feedbackNotice(h.controller.currentNotice!.id, "dismiss");
		await h.controller.check(true);
		const last = h.controller.snapshot().details?.lastCheck;
		assert.equal(last?.result, outcome.result);
		assert.equal(last?.durationMs, 25);
		assert.equal(last?.finishedAt, last!.startedAt + 25);
	}
	h.controller.dispose();
});

test("timeout and cancellation retain their factual outcome when a late transport resolves", async () => {
	const pending = deferred<AssistantMessage>();
	const h = harness({ config: { timeoutMs: 1_000 }, request: async () => pending.promise });
	h.controller.setEnabled(true);
	const timed = h.controller.check(true);
	await flush();
	h.advance(1_000);
	await timed;
	assert.equal(h.controller.snapshot().details?.lastCheck?.result, "timeout");
	pending.resolve(response(finding));
	await flush();
	assert.equal(h.controller.snapshot().details?.lastCheck?.result, "timeout");
	assert.equal(h.controller.currentNotice, null);

	const cancelled = deferred<AssistantMessage>();
	const c = harness({ request: async () => cancelled.promise });
	c.controller.setEnabled(true);
	const check = c.controller.check(true);
	await flush();
	c.controller.noteUserRequest();
	await check;
	assert.equal(c.controller.snapshot().details?.lastCheck?.result, "cancelled");
	c.controller.setEnabled(false);
	c.controller.setEnabled(true);
	assert.equal(c.controller.snapshot().details?.lastCheck?.result, "cancelled");
	cancelled.resolve(response(finding));
	await flush();
	assert.equal(c.controller.snapshot().details?.lastCheck?.result, "cancelled");
	h.controller.dispose(); c.controller.dispose();
});

test("reservation counters roll independently and expose the earliest expiry; notice TTL does not erase check history", async () => {
	const h = harness({ config: { noticeTtlMs: 30_000 }, request: async () => response(finding) });
	h.controller.setEnabled(true);
	await h.controller.check(true);
	const first = h.controller.snapshot().details!;
	assert.equal(first.checksInWindow, 1);
	assert.ok(first.inputCharsInWindow > 0);
	assert.equal(first.windowResetsAt, 3_600_000);
	assert.equal(first.lastCheck?.result, "notice");
	h.advance(30_000);
	assert.equal(h.controller.currentNotice, null);
	assert.equal(h.controller.snapshot().details?.lastCheck?.result, "notice");
	h.advance(3_570_000);
	const rolled = h.controller.snapshot().details!;
	assert.equal(rolled.checksInWindow, 0);
	assert.equal(rolled.inputCharsInWindow, 0);
	assert.equal(rolled.windowResetsAt, null);
	h.controller.dispose();
});

test("a status refresh clears an expired check limit without starting another request", async () => {
	const h = harness({ config: { maxChecksPerHour: 1 } });
	h.controller.setEnabled(true);
	await h.controller.check(true);
	await h.controller.check(true);
	assert.equal(h.controller.snapshot().phase, "limited");
	h.advance(3_600_000);
	h.controller.refreshStatus();
	assert.equal(h.controller.snapshot().phase, "idle");
	assert.equal(h.controller.snapshot().details?.checksInWindow, 0);
	assert.equal(h.requests.length, 1);
	h.controller.dispose();
});

test("snapshot command is quiet, read-only, and remains available to an existing off controller", async () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const snapshots: HeadsUpSnapshot[] = [];
	const notifications: unknown[] = [];
	let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
	const ctx = {
		mode: "tui", hasUI: true, cwd: process.cwd(), isProjectTrusted: () => false,
		sessionManager: SessionManager.inMemory(process.cwd()),
		modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
		ui: { notify: (...args: unknown[]) => notifications.push(args), setWidget: () => {} },
	} as unknown as ExtensionContext;
	headsUp({
		on: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); return () => handlers.delete(name); },
		registerCommand: (_name: string, definition: { handler: typeof command }) => { command = definition.handler; },
		events: { emit: (_channel: string, snapshot: HeadsUpSnapshot) => snapshots.push(snapshot), on: () => () => {} },
	} as unknown as ExtensionAPI, async () => ({ enabled: false, model: "openai-codex/gpt-6-luna", config: DEFAULT_HEADS_UP_CONFIG }));
	await handlers.get("session_start")!({}, ctx);
	const before = snapshots.length;
	const originalOffline = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "1";
	try { await command("snapshot", ctx); } finally {
		if (originalOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = originalOffline;
	}
	assert.equal(snapshots.length, before + 1);
	assert.equal(snapshots.at(-1)?.enabled, false);
	assert.equal(notifications.length, 0);
	await handlers.get("session_shutdown")!({}, ctx);
});
