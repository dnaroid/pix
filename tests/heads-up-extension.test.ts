import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import headsUp, { observerRuntimeAllowed } from "../src/bundled-extensions/heads-up/index.js";
import { DEFAULT_HEADS_UP_CONFIG } from "../src/bundled-extensions/heads-up/config.js";
import type { HeadsUpSnapshot } from "../src/bundled-extensions/heads-up/contract.js";
import { offline } from "../src/bundled-extensions/heads-up/settings.js";

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function response(text: string): AssistantMessage {
	return { role: "assistant", provider: "openai-codex", model: "gpt-6-luna", api: "openai-responses", timestamp: 1,
		content: [{ type: "text", text }], stopReason: "stop",
		usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}
function setup(options: { mode?: string; hasUI?: boolean; finding?: boolean; pending?: boolean } = {}) {
	const handlers = new Map<string, (...args: any[]) => any>();
	let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
	const manager = SessionManager.inMemory(process.cwd());
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
				return response(JSON.stringify(options.finding ? { kind: "heads_up", title: "Old configs will fail", consequence: "The new loader rejects the existing format.", evidenceIds: [userId, assistantId] } : { kind: "none" }));
			} }),
		},
	} as unknown as ExtensionContext;
	const forbidden = () => { throw new Error("observer must not invoke tools or parent messages"); };
	headsUp({
		on: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); return () => handlers.delete(name); },
		registerCommand: (_name: string, definition: { handler: typeof command }) => { command = definition.handler; },
		registerTool: forbidden, sendMessage: forbidden, sendUserMessage: forbidden, appendEntry: forbidden,
		events: { emit: (_channel: string, snapshot: HeadsUpSnapshot) => snapshots.push(snapshot) },
	} as unknown as ExtensionAPI, async () => ({ enabled: false, model: "openai-codex/gpt-6-luna", config: { ...DEFAULT_HEADS_UP_CONFIG, minTurns: 1, minIntervalMs: 0 } }));
	return {
		ctx, manager, userId, assistantId, requests, snapshots, widgets, runAbort,
		get draft() { return draft; }, setDraft: (value: typeof draft) => { draft = value; },
		resolve: () => resolveRequest?.(response('{"kind":"none"}')),
		emit: (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx),
		command: (args: string) => command(args, ctx),
	};
}

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

test("automatic turn hook returns immediately and uses completed agent turns", async (t) => {
	const h = setup({ pending: true }); t.after(() => h.emit("session_shutdown"));
	await h.emit("session_start"); await h.command("on");
	const projection = h.manager.buildSessionProjection();
	const returned = h.emit("turn_end", { outcome: "completed", context: { contextEntries: projection.entries }, message: response("working"), messageEntryId: h.assistantId, toolResults: [], toolResultEntryIds: [] });
	assert.equal(returned, undefined); await flush(); assert.equal(h.requests.length, 1);
	h.resolve(); await flush();
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
