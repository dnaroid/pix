import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import headsUp, { observerRuntimeAllowed } from "../src/bundled-extensions/heads-up/index.js";
import { DEFAULT_HEADS_UP_CONFIG } from "../src/bundled-extensions/heads-up/config.js";
import type { HeadsUpSnapshot } from "../src/bundled-extensions/heads-up/contract.js";
import { offline } from "../src/bundled-extensions/heads-up/settings.js";
import { DESKTOP_OBSERVER_PREFERENCE } from "../src/bundled-extensions/heads-up/desktop-preference.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("final child report reaches idle parent observer without followup turn; generic notices do not", async (t) => {
	const h = setup(); t.after(() => h.emit("session_shutdown")); await h.emit("session_start"); await h.command("on");
	const publish = h.bus.get("async-subagents:delegated-evidence")!;
	const identity = { version: 1, launchId: "child-launch", sessionId: h.manager.getSessionId(), anchorId: h.assistantId, agentId: "child" };
	publish({ role: "custom", customType: "async-subagents-agent-completion", content: "done" });
	await tick(); assert.equal(h.requests.length, 0);
	publish({ ...identity, phase: "started" });
	publish({ ...identity, phase: "completed", runDir: "/run", status: "done", report: "Done. Tests pass. Removed support for top-level port." });
	await tick(); assert.equal(h.requests.length, 1);
	assert.match(JSON.stringify(h.requests[0]?.context), /child-reported/);
	assert.match(JSON.stringify(h.requests[0]?.context), /Removed support/);
	assert.equal(h.manager.getEntries().filter((entry) => entry.type === "message").length, 2);
});

test("late completion cannot cross branch, session, off/on, stop or new-request ownership boundaries", async () => {
	for (const event of ["session_before_tree", "session_before_fork", "session_before_switch", "session_before_compact", "input", "agent_before_settle", "off"]) {
		const h = setup(); await h.emit("session_start"); await h.command("on");
		const publish = h.bus.get("async-subagents:delegated-evidence")!;
		const identity = { version: 1, launchId: "same-launch", sessionId: h.manager.getSessionId(), anchorId: h.assistantId, agentId: "child" };
		publish({ ...identity, phase: "started" });
		if (event === "off") { await h.command("off"); await h.command("on"); }
		else h.emit(event, { source: "interactive", outcome: "aborted" });
		publish({ ...identity, phase: "completed", runDir: "/run", status: "done", report: "Stale forbidden evidence" });
		await tick(); assert.equal(h.requests.length, 0, event);
		await h.command("check"); await flush(); assert.doesNotMatch(JSON.stringify(h.requests), /Stale forbidden/);
		h.emit("session_shutdown"); assert.equal(h.bus.size, 0);
	}
});

test("nearby children coalesce with distinct provenance; another session is excluded", async (t) => {
	const h = setup(); t.after(() => h.emit("session_shutdown")); await h.emit("session_start"); await h.command("on");
	const publish = h.bus.get("async-subagents:delegated-evidence")!;
	for (const id of ["one", "two", "foreign"]) {
		const identity = { version: 1, launchId: id, sessionId: id === "foreign" ? "another-session" : h.manager.getSessionId(), anchorId: h.assistantId, agentId: id };
		publish({ ...identity, phase: "started" });
		publish({ ...identity, phase: "completed", runDir: `/run/${id}`, status: "done", report: `Reported change from ${id}` });
	}
	await tick(); assert.equal(h.requests.length, 1);
	const input = JSON.stringify(h.requests[0]?.context);
	assert.match(input, /delegated:one/); assert.match(input, /delegated:two/); assert.doesNotMatch(input, /foreign/);
});
function response(text: string): AssistantMessage {
	return { role: "assistant", provider: "openai-codex", model: "gpt-6-luna", api: "openai-responses", timestamp: 1,
		content: [{ type: "text", text }], stopReason: "stop",
		usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}
function setup(options: { mode?: string; hasUI?: boolean; finding?: boolean; pending?: boolean; manager?: SessionManager; enabled?: boolean; saveError?: boolean } = {}) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const bus = new Map<string, (event: unknown) => void>();
	let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
	const manager = options.manager ?? SessionManager.inMemory(process.cwd());
	const userId = manager.appendMessage({ role: "user", content: "Keep old configuration compatible", timestamp: 1 });
	const assistantId = manager.appendMessage(response("Changed loader to reject old configuration"));
	const snapshots: HeadsUpSnapshot[] = [];
	const widgets: unknown[][] = [];
	const requests: { context: Context; options: SimpleStreamOptions }[] = [];
	let draft = { text: "", images: [] as unknown[] };
	let resolveRequest: ((value: AssistantMessage) => void) | undefined;
	const runAbort = new AbortController();
	const ctx = {
		mode: options.mode ?? "tui", hasUI: options.hasUI ?? true, cwd: process.cwd(), signal: runAbort.signal,
		sessionManager: manager, isProjectTrusted: () => false,
		ui: { notify: () => {}, setWidget: (...args: unknown[]) => widgets.push(args), getEditorSnapshot: () => draft, setEditorText: (text: string) => { draft = { ...draft, text }; } },
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true,
			streamSimple: (_model: unknown, context: Context, requestOptions: SimpleStreamOptions) => ({ result: async () => {
				requests.push({ context, options: requestOptions });
				if (options.pending) return new Promise<AssistantMessage>((resolve) => { resolveRequest = resolve; });
				return response(JSON.stringify(options.finding ? { kind: "heads_up", notices: [{ id: null, title: "Old configs will fail", consequence: "The new loader rejects the existing format.", evidenceIds: [userId, assistantId] }] } : { kind: "none" }));
			} }),
		},
	} as unknown as ExtensionContext;
	const forbidden = () => { throw new Error("observer must not invoke tools or parent messages"); };
	headsUp({
		on: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); return () => handlers.delete(name); },
		registerCommand: (_name: string, definition: { handler: typeof command }) => { command = definition.handler; },
		registerTool: forbidden, sendMessage: forbidden, sendUserMessage: forbidden,
		appendEntry: (type: string, data: unknown) => {
			if (ctx.mode !== "rpc") forbidden();
			if (options.saveError) throw new Error("Could not save Observer preference");
			manager.appendCustomEntry(type, data);
		},
		events: { emit: (_channel: string, snapshot: HeadsUpSnapshot) => snapshots.push(snapshot), on: (channel: string, handler: (event: unknown) => void) => { bus.set(channel, handler); return () => bus.delete(channel); } },
	} as unknown as ExtensionAPI, async () => ({ enabled: options.enabled ?? false, model: "openai-codex/gpt-6-luna", config: { ...DEFAULT_HEADS_UP_CONFIG, minTurns: 1, minIntervalMs: 0 } }));
	return {
		ctx, manager, userId, assistantId, requests, snapshots, widgets, runAbort, bus,
		get draft() { return draft; }, setDraft: (value: typeof draft) => { draft = value; },
		resolve: (value = '{"kind":"none"}') => resolveRequest?.(response(value)),
		emit: (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx),
		command: (args: string) => command(args, ctx),
	};
}

test("TUI stack commands navigate one card without inference and discuss/feedback target selection", async (t) => {
	const h = setup({ pending: true }); t.after(() => h.emit("session_shutdown"));
	await h.emit("session_start"); await h.command("on"); await h.command("check"); await flush();
	h.resolve(JSON.stringify({ kind: "heads_up", notices: ["Compatibility", "Billing", "Isolation"].map((title) => ({ id: null, title, consequence: `${title} conflict`, evidenceIds: [h.assistantId] })) }));
	await flush(); assert.equal(h.snapshots.at(-1)?.notices?.length, 3);
	assert.match(JSON.stringify(h.widgets.at(-1)), /1 \/ 3/);
	await h.command("next"); assert.equal(h.snapshots.at(-1)?.notice?.title, "Billing");
	assert.match(JSON.stringify(h.widgets.at(-1)), /2 \/ 3/);
	await h.command("discuss"); assert.match(h.draft.text, /Billing conflict/);
	await h.command("dismiss"); assert.equal(h.snapshots.at(-1)?.notices?.length, 2);
	assert.equal(h.snapshots.at(-1)?.notice?.title, "Isolation");
	await h.command("prev"); assert.equal(h.snapshots.at(-1)?.notice?.title, "Compatibility");
	assert.equal(h.requests.length, 1);
});

test("message completion hides claims before persistence, but assistant progress does not", async (t) => {
	const h = setup({ finding: true }); t.after(() => h.emit("session_shutdown"));
	await h.emit("session_start"); await h.command("on"); await h.command("check"); await flush();
	assert.ok(h.snapshots.at(-1)?.notice);
	h.emit("message_end", { message: response("Still working") });
	assert.ok(h.snapshots.at(-1)?.notice);
	const entries = h.manager.getEntries().length;
	h.emit("message_end", { message: { role: "toolResult", toolCallId: "retest", toolName: "shell", isError: false, content: [{ type: "text", text: "All tests pass" }], timestamp: 3 } });
	assert.equal(h.manager.getEntries().length, entries, "event invalidation does not depend on persistence");
	assert.equal(h.snapshots.at(-1)?.notice, null);
	assert.deepEqual(h.snapshots.at(-1)?.notices, []);
	assert.equal(h.snapshots.at(-1)?.awaitingReview, true);
	assert.match(JSON.stringify(h.widgets.at(-1)), /Awaiting fresh review/);
	assert.doesNotMatch(JSON.stringify(h.widgets.at(-1)), /Old configs will fail/);
	await h.command("discuss"); assert.equal(h.draft.text, "");
	assert.equal(h.requests.length, 1, "hiding does not spend a request");
});

test("Desktop on/off survives reopening the session file without enabling other sessions or TUI", async (t) => {
	const previous = process.env.PIX_ACP_SESSION_STATE_BRIDGE;
	process.env.PIX_ACP_SESSION_STATE_BRIDGE = "1";
	t.after(() => { if (previous === undefined) delete process.env.PIX_ACP_SESSION_STATE_BRIDGE; else process.env.PIX_ACP_SESSION_STATE_BRIDGE = previous; });
	const directory = mkdtempSync(join(tmpdir(), "observer-preference-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const manager = SessionManager.create(process.cwd(), directory);
	const first = setup({ mode: "rpc", manager });
	await first.emit("session_start"); await first.command("on"); first.emit("session_shutdown");
	const file = manager.getSessionFile()!;
	const restored = setup({ mode: "rpc", manager: SessionManager.open(file) });
	await restored.emit("session_start");
	assert.equal(restored.snapshots.at(-1)?.enabled, true);
	assert.equal(restored.requests.length, 0, "restoring enablement must not run inference");
	assert.equal(restored.manager.buildSessionProjection().entries.some((entry) => entry.messages.some((message) => JSON.stringify(message).includes(DESKTOP_OBSERVER_PREFERENCE))), false);
	await restored.command("off"); restored.emit("session_shutdown");
	const disabled = setup({ mode: "rpc", manager: SessionManager.open(file), enabled: true });
	await disabled.emit("session_start");
	assert.equal(disabled.snapshots.at(-1)?.enabled, false, "explicit off overrides default-on");
	disabled.emit("session_shutdown");
	const other = setup({ mode: "rpc" });
	await other.emit("session_start"); assert.equal(other.snapshots.at(-1)?.enabled, false); other.emit("session_shutdown");
	const tui = setup({ manager: SessionManager.open(file), enabled: true });
	await tui.emit("session_start"); assert.equal(tui.snapshots.at(-1)?.enabled, true, "TUI ignores Desktop preferences");
	await tui.command("off"); tui.emit("session_shutdown");
});

test("Desktop preference validation, branch stability and failed persistence", async (t) => {
	const previous = process.env.PIX_ACP_SESSION_STATE_BRIDGE;
	process.env.PIX_ACP_SESSION_STATE_BRIDGE = "1";
	t.after(() => { if (previous === undefined) delete process.env.PIX_ACP_SESSION_STATE_BRIDGE; else process.env.PIX_ACP_SESSION_STATE_BRIDGE = previous; });
	const h = setup({ mode: "rpc" });
	t.after(() => h.emit("session_shutdown"));
	await h.emit("session_start"); await h.command("on");
	h.manager.appendCustomEntry(DESKTOP_OBSERVER_PREFERENCE, { version: 1, enabled: "false" });
	h.manager.appendCustomEntry(DESKTOP_OBSERVER_PREFERENCE, { version: 2, enabled: false });
	h.manager.branch(h.userId);
	await h.emit("session_start");
	assert.equal(h.snapshots.at(-1)?.enabled, true, "preference belongs to the session, not branch navigation");
	const failed = setup({ mode: "rpc", saveError: true });
	t.after(() => failed.emit("session_shutdown"));
	await failed.emit("session_start");
	await assert.rejects(failed.command("on"), /Could not save/);
	assert.equal(failed.snapshots.at(-1)?.enabled, false, "do not publish a successful toggle when save fails");
});

test("extension defaults off; check and stop commands never await the model or wake parent", async (t) => {
	const h = setup({ pending: true }); t.after(() => h.emit("session_shutdown"));
	await h.emit("session_start"); assert.equal(h.requests.length, 0); assert.equal(h.snapshots.at(-1)?.enabled, false);
	await h.command("check"); assert.equal(h.requests.length, 0);
	await h.command("on"); await h.command("check"); await flush();
	assert.equal(h.requests.length, 1); assert.equal(h.snapshots.at(-1)?.phase, "checking");
	await h.command("off"); assert.equal(h.requests[0]?.options.signal?.aborted, true);
	h.resolve(); await flush(); assert.equal(h.snapshots.at(-1)?.notice, null);
	assert.equal(h.manager.getEntries().filter((entry) => entry.type === "usage" && entry.kind === "heads-up").length, 1);
});

test("automatic checks wait for final settlement, including failed HUD run, repair and successful retest", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = setup({ pending: true }); t.after(() => h.emit("session_shutdown"));
	await h.emit("session_start"); await h.command("on"); h.emit("agent_start");
	for (const [toolName, text] of [["codemode", "Script failed: 5 failed | 77 passed (82)"], ["apply_patch", "Fixed h-7/h-6 and accessible quota-label expectations"], ["shell", "Same six files: 82 passed (82)"], ["shell", "Typecheck: 0 errors, 0 warnings"]]) {
		const message = response("working"); const messageEntryId = h.manager.appendMessage(message);
		const result = { role: "toolResult" as const, toolCallId: toolName!, toolName: toolName!, isError: false, content: [{ type: "text" as const, text: text! }], timestamp: 2 };
		const resultId = h.manager.appendMessage(result);
		const returned = h.emit("turn_end", { outcome: "completed", context: { contextEntries: h.manager.buildSessionProjection().entries }, message, messageEntryId, toolResults: [result], toolResultEntryIds: [resultId] });
		assert.equal(returned, undefined); t.mock.timers.tick(0); await flush(); assert.equal(h.requests.length, 0);
	}
	h.emit("agent_before_settle", { outcome: "completed", continue: true });
	t.mock.timers.tick(0); await flush(); assert.equal(h.requests.length, 0, "boundary continuations must finish first");
	h.emit("agent_before_settle", { outcome: "completed", continue: false });
	assert.equal(h.emit("agent_settled"), undefined);
	t.mock.timers.tick(0); await flush(); assert.equal(h.requests.length, 1);
	const input = JSON.stringify(h.requests[0]!.context.messages);
	assert.match(input, /82 passed/); assert.match(input, /0 errors, 0 warnings/);
	assert.ok(input.indexOf("5 failed") < input.indexOf("82 passed"));
	h.resolve(); await flush();
	assert.equal(h.snapshots.at(-1)?.notice, null);
});

test("aborted and failed settlement never starts an automatic observer check", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	for (const outcome of ["aborted", "error"]) {
		const h = setup(); await h.emit("session_start"); await h.command("on"); h.emit("agent_start");
		h.emit("turn_end", { outcome: "completed", context: { contextEntries: h.manager.buildSessionProjection().entries }, message: response("working"), messageEntryId: h.assistantId, toolResults: [], toolResultEntryIds: [] });
		h.emit("agent_before_settle", { outcome }); h.emit("agent_settled");
		t.mock.timers.tick(0); await flush(); assert.equal(h.requests.length, 0);
		h.emit("session_shutdown");
	}
});

test("user stop aborts observer; new input clears current finding", async (t) => {
	const h = setup({ pending: true }); t.after(() => h.emit("session_shutdown"));
	await h.emit("session_start"); await h.command("on"); h.emit("agent_start"); await h.command("check"); await flush();
	h.runAbort.abort(); assert.equal(h.requests[0]?.options.signal?.aborted, true);
	h.resolve(); await flush(); assert.equal(h.snapshots.at(-1)?.notice, null);
});

test("projected context edits are respected before inference and do not expose removed raw text", async (t) => {
	const h = setup(); t.after(() => h.emit("session_shutdown")); await h.emit("session_start"); await h.command("on");
	h.manager.appendContextEdit(h.assistantId, { content: [{ type: "text", text: "The compatibility change was reverted." }] });
	await h.command("check"); await flush();
	const request = JSON.stringify(h.requests[0]?.context);
	assert.match(request, /compatibility change was reverted/); assert.doesNotMatch(request, /Changed loader to reject/);
});

test("persisted shell retest before turn_end prevents delivery of the earlier codemode failure", async (t) => {
	const h = setup({ pending: true }); t.after(() => h.emit("session_shutdown"));
	const failedId = h.manager.appendMessage({ role: "toolResult", toolCallId: "nested-run", toolName: "codemode", isError: false,
		content: [{ type: "text", text: "Script completed\nOutput:\n5 failed | 77 passed (82)\nold h-7 expectations" }], timestamp: 2 });
	await h.emit("session_start"); await h.command("on"); await h.command("check"); await flush();
	h.manager.appendMessage(response("Fixed h-7 to h-6 and quota aria-label expectation"));
	const retestId = h.manager.appendMessage({ role: "toolResult", toolCallId: "rerun", toolName: "shell", isError: false,
		content: [{ type: "text", text: "TEST_RESULT: passed\nSame six files: 82 passed\nexit: 0" }], timestamp: 3 });
	// Real SDK persists each message before turn_end; no completed-turn hook yet.
	h.resolve(JSON.stringify({ kind: "heads_up", notices: [{ id: null, title: "HUD tests failed", consequence: "5/82 failed; no rerun exists", evidenceIds: [failedId] }] }));
	await flush(); assert.equal(h.snapshots.at(-1)?.notice, null);
	assert.equal(h.snapshots.at(-1)?.reason, "evidence changed; awaiting fresh check");
	await h.command("check"); await flush(); assert.equal(h.requests.length, 2);
	const request = h.requests[1]!.context.messages[0]!.content;
	assert.ok(Array.isArray(request));
	const input = JSON.parse((request[0] as { text: string }).text);
	assert.ok(input.records.findIndex((record: { id: string }) => record.id === failedId) < input.records.findIndex((record: { id: string }) => record.id === retestId));
	assert.match(JSON.stringify(input), /82 passed/);
	h.resolve(); await flush(); assert.equal(h.snapshots.at(-1)?.notice, null);
	assert.equal(h.manager.getEntries().filter((entry) => entry.type === "usage" && entry.kind === "heads-up").length, 2);
});

test("headless, print and standalone RPC do not activate even with explicit command", async () => {
	for (const mode of ["print", "json", "rpc"]) {
		const h = setup({ mode, hasUI: mode === "rpc" });
		if (mode === "rpc" && process.env.PIX_ACP_SESSION_STATE_BRIDGE === "1") continue;
		await h.emit("session_start"); await h.command("on"); await h.command("check");
		assert.equal(h.requests.length, 0); h.emit("session_shutdown");
	}
	for (const word of ["1", "true", "yes", " ON "]) assert.equal(offline({ PI_OFFLINE: word }), true);
});

test("explain uses existing data; discuss preserves attachments and existing text, never submits", async (t) => {
	const h = setup({ finding: true }); t.after(() => h.emit("session_shutdown"));
	await h.emit("session_start"); await h.command("on"); await h.command("check"); await flush();
	assert.ok(h.snapshots.at(-1)?.notice);
	await h.command("explain"); assert.equal(h.requests.length, 1);
	h.setDraft({ text: "", images: [{}] }); await h.command("discuss"); assert.equal(h.draft.text, ""); assert.equal(h.draft.images.length, 1);
	h.setDraft({ text: " ", images: [] }); await h.command("discuss"); assert.equal(h.draft.text, " ");
	h.setDraft({ text: "", images: [] }); await h.command("discuss"); assert.match(h.draft.text, /Please check this observer note/);
	assert.equal(h.requests.length, 1);
	h.emit("input", { text: "different task", source: "interactive" }); assert.equal(h.snapshots.at(-1)?.notice, null);
});
