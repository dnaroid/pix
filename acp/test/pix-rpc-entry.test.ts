import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("Pix RPC freezes safe turn boundary metadata after SDK assistant/tool persistence", async () => {
	const source = await readFile(new URL("../src/pi/pix-rpc-entry.js", import.meta.url), "utf8");
	const sdk = await readFile(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js", import.meta.url), "utf8");
	const start = sdk.indexOf("_handleAgentEvent = async (event) => {");
	const end = sdk.indexOf("    _willRetryAfterAgentEnd(event)", start);
	assert.ok(start >= 0 && end > start);
	const handler = sdk.slice(start, end);
	const emitted: Array<{ type: string; pixForkLeafId?: string; pixForkSessionPath?: string }> = [];
	let leaf = "user";
	const sessionManager = { getLeafId: () => leaf, getSessionFile: () => "/session.jsonl",
		appendMessage: (message: { role: string }) => { leaf = message.role; return leaf; } };
	// Exercise the installed SDK's actual event handler and Pix wrapper, not a
	// duplicate implementation that could silently diverge on an SDK update.
	const context = { emitted, sessionManager, contentText: () => "" };
	runInNewContext(`class AgentSession {
		sessionManager = sessionManager; _entryIdsByMessage = new Map(); _retryAttempt = 0;
		async _emitExtensionEvent() {} _flushPendingCustomMessages() {}
		_emit(event) { emitted.push(event); }
		${handler}
	}
	${source.slice(source.indexOf("const originalForkBoundaryEmit ="), source.indexOf("const PIX_PAUSE_MESSAGE ="))}
	globalThis.session = new AgentSession();`, context);
	const session = (context as unknown as { session: { _handleAgentEvent(event: unknown): Promise<void> } }).session;
	await session._handleAgentEvent({ type: "message_end", message: { role: "assistant", stopReason: "toolUse" } });
	await session._handleAgentEvent({ type: "message_end", message: { role: "toolResult" } });
	await session._handleAgentEvent({ type: "turn_end", toolResults: [] });
	leaf = "later-user";
	assert.equal(emitted[2]?.pixForkLeafId, "toolResult");
	assert.equal(emitted[2]?.pixForkSessionPath, "/session.jsonl");
	assert.equal(emitted[0]?.pixForkLeafId, undefined, "unsafe message_end must not expose a boundary");
	const { toJsonEvent } = await import(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/modes/json-event.js", import.meta.url).href);
	assert.equal(toJsonEvent(emitted[2]).pixForkLeafId, "toolResult", "RPC must preserve the extra boundary fields");
});

test("Pix RPC wait control resumes a paused transcript without persisting the envelope", async () => {
	const source = await readFile(new URL("../src/pi/pix-rpc-entry.js", import.meta.url), "utf8");
	const patch = source.slice(source.indexOf('const PIX_QUOTA_CONTROL_CUSTOM_TYPE ='), source.indexOf("const originalPrompt ="));
	let resumed = 0;
	let pauses = 0;
	let forwarded = 0;
	const record = { state: "paused" };
	class Session {
		isStreaming = false;
		agent = { state: { isStreaming: false } };
		async sendCustomMessage(_message: unknown) { forwarded++; }
	}
	runInNewContext(patch, { AgentSession: Session, bindPause: () => record,
		canContinue: () => true, requestPause: () => { pauses++; },
		continueSession: async (_session: unknown, _record: unknown, isCurrent: () => boolean) => { if (isCurrent()) resumed++; },
	});
	const session = new Session();
	const values: unknown[] = [];
	const details = { action: "continue", isCurrent: () => true, accepted() {}, settle: (value: unknown) => values.push(value) };
	await session.sendCustomMessage({ customType: "pix-quota-control", details });
	assert.equal(resumed, 1);
	assert.equal(forwarded, 0);
	assert.deepEqual(values, [true]);
	details.isCurrent = () => false;
	await session.sendCustomMessage({ customType: "pix-quota-control", details });
	assert.equal(resumed, 1);
	record.state = "idle";
	session.isStreaming = true;
	details.action = "pause";
	await session.sendCustomMessage({ customType: "pix-quota-control", details });
	assert.equal(pauses, 1);
	await session.sendCustomMessage({ customType: "ordinary" });
	assert.equal(forwarded, 1);
});

test("Pix RPC installs the finishTurn pause hook before starting a normal prompt", async () => {
	const source = await readFile(new URL("../src/pi/pix-rpc-entry.js", import.meta.url), "utf8");
	const promptPatchStart = source.indexOf("AgentSession.prototype.prompt =");
	assert.notEqual(promptPatchStart, -1, "prompt patch must exist");

	const promptPatch = source.slice(promptPatchStart);
	const bindIndex = promptPatch.indexOf("bindPause(this);");
	const originalPromptIndex = promptPatch.indexOf("return originalPrompt.call(this, text, options);");

	assert.notEqual(bindIndex, -1, "normal prompts must bind the pause controller");
	assert.notEqual(originalPromptIndex, -1, "normal prompts must delegate to AgentSession.prompt");
	assert.ok(
		bindIndex < originalPromptIndex,
		"pause hook must be installed before AgentSession captures finishTurn for the run",
	);
});

test("Pix RPC pauses through finishTurn while preserving an existing end decision", async () => {
	const source = await readFile(new URL("../src/pi/pix-rpc-entry.js", import.meta.url), "utf8");
	assert.match(source, /const originalFinishTurn = session\.agent\.finishTurn/u);
	assert.match(source, /session\.agent\.finishTurn = async \(turn, signal\)/u);
	assert.match(source, /if \(priorDecision\?\.action === "end"\)/u);
	assert.match(source, /if \(priorDecision\?\.action === "continue"\) return priorDecision/u);
	assert.match(source, /return \{ action: "end" \};/u);
	assert.doesNotMatch(source, /shouldStopAfterTurn/u);
	assert.match(source, /_runSystemPromptOptions/u);
	assert.match(source, /_flushPendingCustomMessages/u);
	assert.match(source, /_runBeforeSettleBoundary/u);
});

test("Pix RPC clears todos through the handler, never a prompt, and acknowledges only completion", async () => {
	const source = await readFile(new URL("../src/pi/pix-rpc-entry.js", import.meta.url), "utf8");
	const patch = source.slice(source.indexOf("const originalPrompt ="), source.indexOf("const { main }"));
	let calls = 0;
	let idle = true;
	let handlerError: Error | undefined;
	let release!: () => void;
	let gate: Promise<void> | undefined = new Promise<void>((resolve) => { release = resolve; });
	const context = { isIdle: () => idle };
	let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined = {
		async handler(args, ctx) {
			assert.equal(args, "");
			assert.equal(ctx, context);
			calls++;
			await gate;
			if (handlerError) throw handlerError;
		},
	};
	class Session {
		extensionRunner = {
			getCommand(name: string) { assert.equal(name, "todos-clear"); return command; },
			createCommandContext() { return context; },
		};
		async prompt(_text: string, _options?: { preflightResult: (disposition: string) => void }): Promise<void> {
			assert.fail("clear must not enter normal prompt dispatch");
		}
	}
	const sentinel = "\u0000pix:clear-todos";
	runInNewContext(patch, {
		AgentSession: Session, PIX_CLEAR_TODOS_MESSAGE: sentinel,
		PIX_BTW_RPC_PREFIX: "\u0000pix:btw:",
		PIX_PAUSE_MESSAGE: "pause", PIX_CONTINUE_MESSAGE: "continue",
		bindPause() { assert.fail("clear must not bind a model run"); },
	});
	const acknowledgements: string[] = [];
	const options = { preflightResult: (disposition: string) => acknowledgements.push(disposition) };
	const session = new Session();
	const pending = session.prompt(sentinel, options);
	assert.equal(calls, 1);
	assert.deepEqual(acknowledgements, []);
	release();
	await pending;
	assert.deepEqual(acknowledgements, ["handled"]);
	gate = undefined;
	handlerError = new Error("snapshot failed");
	await assert.rejects(session.prompt(sentinel, options), /snapshot failed/u);
	idle = false;
	await assert.rejects(session.prompt(sentinel, options), /session is busy/u);
	assert.equal(calls, 2, "busy rejection must not run the handler");
	command = undefined;
	await assert.rejects(session.prompt(sentinel, options), /Todo extension is unavailable/u);
	assert.deepEqual(acknowledgements, ["handled"], "failed requests must never report success");
});

test("Pix RPC dispatches hidden LSP control and emits only a correlated status snapshot", async () => {
	const source = await readFile(new URL("../src/pi/pix-rpc-entry.js", import.meta.url), "utf8");
	const patch = source.slice(source.indexOf("const originalPrompt ="), source.indexOf("const { main }"));
	const output: string[] = [];
	let calls = 0;
	let forwarded = 0;
	let command: { handler(args: string, context: unknown): Promise<void> } | undefined = {
		async handler(args, context) {
			calls++;
			assert.deepEqual(JSON.parse(args), { action: "start", id: "ts", root: "/workspace" });
			const ctx = context as { ui: { setStatus(key: string, text?: string): void; notify(message: string): void } };
			ctx.ui.notify("trust prompt remains available");
			ctx.ui.setStatus("pix:lsp", JSON.stringify({ servers: [{ id: "ts", root: "/workspace", state: "running" }], warnings: [] }));
		},
	};
	const context = { ui: { setStatus() {}, notify() { forwarded++; } } };
	const originalSetStatus = context.ui.setStatus;
	class Session {
		extensionRunner = {
			getCommand(name: string) { assert.equal(name, "lsp-control"); return command; },
			createCommandContext() { return context; },
		};
		_emit(event: unknown) { output.push(JSON.stringify(event)); }
		async prompt(_text: string, _options?: { preflightResult(disposition: string): void }) { assert.fail("must not dispatch a model prompt"); }
	}
	runInNewContext(patch, {
		AgentSession: Session, PIX_LSP_CONTROL_PREFIX: "\u0000pix:lsp-control:",
		PIX_BTW_RPC_PREFIX: "\u0000pix:btw:",
		PIX_PAUSE_MESSAGE: "pause", PIX_CONTINUE_MESSAGE: "continue", PIX_CLEAR_TODOS_MESSAGE: "clear",
		bindPause() { assert.fail("must not bind model run"); },
		process: { stdout: { write() { assert.fail("RPC stdout is taken over by the SDK; emit via the session event stream"); } } },
	});
	const statuses: string[] = [];
	const session = new Session();
	await session.prompt("\u0000pix:lsp-control:{\"requestId\":\"req-1\",\"action\":\"start\",\"id\":\"ts\",\"root\":\"/workspace\"}", {
		preflightResult(value: string) { statuses.push(value); },
	});
	assert.equal(calls, 1);
	assert.equal(forwarded, 1, "non-LSP UI methods must retain their original behavior");
	assert.equal(context.ui.setStatus, originalSetStatus, "snapshot capture must not mutate the shared SDK UI");
	assert.deepEqual(statuses, ["handled"]);
	assert.deepEqual(JSON.parse(output[0]!), { type: "pix_lsp_response", requestId: "req-1", snapshot: {
		servers: [{ id: "ts", root: "/workspace", state: "running" }], warnings: [],
	} });
	command = undefined;
	await assert.rejects(session.prompt("\u0000pix:lsp-control:{\"requestId\":\"req-2\",\"action\":\"status\"}", {
		preflightResult(value: string) { statuses.push(value); },
	}), /LSP control extension is unavailable/u);
	assert.deepEqual(statuses, ["handled"]);
});

test("Pix RPC pause preflight reports SDK dispositions only on success", async () => {
	const source = await readFile(new URL("../src/pi/pix-rpc-entry.js", import.meta.url), "utf8");
	const patch = source.slice(source.indexOf("const originalPrompt ="), source.indexOf("const { main }"));
	let streaming = false;
	class Session {
		isStreaming = false;
		agent = { state: { isStreaming: false } };
		async prompt(_text: string, _options?: { preflightResult: (disposition: string) => void }) {
			assert.fail("pause must not enter normal prompt dispatch");
		}
	}
	const session = new Session();
	runInNewContext(patch, {
		AgentSession: Session, PIX_PAUSE_MESSAGE: "pause", PIX_CONTINUE_MESSAGE: "continue",
		PIX_BTW_RPC_PREFIX: "\u0000pix:btw:",
		PIX_CLEAR_TODOS_MESSAGE: "clear",
		requestPause() { if (!streaming) throw new Error("Agent is not running"); },
	});
	const dispositions: string[] = [];
	const options = { preflightResult: (value: string) => dispositions.push(value) };
	await assert.rejects(session.prompt("pause", options), /Agent is not running/u);
	assert.deepEqual(dispositions, [], "failed preflight must let RPC report an error");
	streaming = true;
	await session.prompt("pause", options);
	assert.deepEqual(dispositions, ["handled"]);
});

test("Pix RPC exposes live DCP token savings through session stats", async () => {
	const source = await readFile(new URL("../src/pi/pix-rpc-entry.js", import.meta.url), "utf8");
	assert.match(source, /Symbol\.for\("pix\.dcp\.runtime-stats"\)/u);
	assert.match(source, /AgentSession\.prototype\.getSessionStats = function pixGetSessionStats/u);
	assert.match(source, /pixDcpTokensSaved/u);
});

test("Pix RPC forwards only bounded prepared-map metadata and preserves legacy stats", async () => {
	const source = await readFile(new URL("../src/pi/pix-rpc-entry.js", import.meta.url), "utf8");
	const patch = source.slice(source.indexOf("const PIX_DCP_RUNTIME_STATS_SYMBOL"), source.indexOf("/** @type {WeakMap"));
	class Session { getSessionStats(): Record<string, unknown> { return { messageCount: 3 }; } }
	let contextMap: unknown = {
		revision: 1, sessionEpoch: 0, generatedAt: 1000, body: "private",
		tokenEstimates: { candidate: 100, protected: 20, compressed: 30, retained: 50, arguments: "private" },
	};
	const sandbox = {
		AgentSession: Session,
		[Symbol.for("pix.dcp.runtime-stats")]: () => ({ tokensSaved: 12, contextMap }),
	};
	runInNewContext(patch, sandbox);
	const stats = () => JSON.parse(JSON.stringify(new Session().getSessionStats()));
	assert.deepEqual(stats(), { messageCount: 3, pixDcpTokensSaved: 12, pixDcpContextMap: {
		revision: 1, sessionEpoch: 0, generatedAt: 1000,
		tokenEstimates: { candidate: 100, protected: 20, compressed: 30, retained: 50 },
	} });
	for (const invalid of [undefined, { ...(contextMap as object), generatedAt: Number.MAX_SAFE_INTEGER },
		{ ...(contextMap as object), tokenEstimates: { candidate: -1, protected: 0, compressed: 0, retained: 0 } },
		{ ...(contextMap as object), tokenEstimates: { candidate: 0, protected: 0, compressed: 0, retained: 0 } },
		{ ...(contextMap as object), tokenEstimates: { candidate: Number.MAX_SAFE_INTEGER, protected: 1, compressed: 0, retained: 0 } }]) {
		contextMap = invalid;
		assert.deepEqual(stats(), { messageCount: 3, pixDcpTokensSaved: 12 });
	}
});

/**
 * Loads the Anthropic header-capture patch with stand-ins shaped like the real
 * SDK surface it hooks: `ModelRuntime.prototype.stream/streamSimple` receiving
 * `{ sessionId, onResponse }` options, and `AgentSession.prototype.getSessionStats`.
 * `respond(response)` replays a provider response through whichever stream call
 * the patch wraps, exactly like pi-ai's `onResponse` hook would.
 */
async function loadAnthropicUsageCapture() {
	const source = await readFile(new URL("../src/pi/pix-rpc-entry.js", import.meta.url), "utf8");
	const patch = source.slice(
		source.indexOf("// --- Anthropic API-key response-header usage capture ---"),
		source.indexOf("// --- end Anthropic API-key response-header usage capture ---"),
	);
	const seenOptions: unknown[] = [];
	let currentResponse: { status: number; headers: Record<string, string> } = { status: 200, headers: {} };
	class ModelRuntime {
		constructor(private readonly subscription = false) {}
		isUsingSubscription() { return this.subscription; }
		stream(model: unknown, context: unknown, options: unknown) {
			seenOptions.push(options);
			return (options as { onResponse?: (response: unknown, model: unknown) => unknown }).onResponse?.(currentResponse, model);
		}
		streamSimple(model: unknown, context: unknown, options: unknown) {
			seenOptions.push(options);
			return (options as { onResponse?: (response: unknown, model: unknown) => unknown }).onResponse?.(currentResponse, model);
		}
	}
	class Session {
		constructor(sessionId: string, model: unknown) {
			this.sessionId = sessionId;
			this.agent = { state: { model } };
		}
		getSessionStats(): Record<string, unknown> { return { sessionId: this.sessionId, messageCount: 1 }; }
		private readonly sessionId: string;
		readonly agent: { state: { model: unknown } };
	}
	runInNewContext(patch, { AgentSession: Session, ModelRuntime });
	return {
		ModelRuntime,
		Session,
		seenOptions,
		respond(response: { status: number; headers: Record<string, string> }) { currentResponse = response; },
	};
}

const RATE_HEADERS = {
	"content-type": "application/json",
	"Anthropic-Ratelimit-Requests-Limit": "1000",
	"anthropic-ratelimit-requests-remaining": "250",
	"anthropic-ratelimit-requests-reset": "27s",
	"x-api-key": "sk-ant-api03-SECRET",
	"authorization": "Bearer SECRET",
	"request-id": "req_123",
};

test("Pix RPC captures Anthropic rate-limit headers through the real stream hook", async () => {
	const harness = await loadAnthropicUsageCapture();
	harness.respond({ status: 200, headers: RATE_HEADERS });
	const innerCalls: unknown[] = [];
	const runtime = new harness.ModelRuntime(false);
	const claude4 = { provider: "anthropic", id: "claude-4" };
	const options = {
		sessionId: "session-1",
		onResponse: async (response: unknown, model: unknown) => {
			innerCalls.push({ response, model });
			return "inner-result";
		},
	};

	const result = await runtime.streamSimple(claude4, {}, options);
	assert.equal(result, "inner-result", "the wrapped onResponse keeps the SDK callback's result");
	assert.equal(innerCalls.length, 1, "the SDK's own after_provider_response hook still fires");
	assert.notEqual(harness.seenOptions[0], options, "capture wraps the options instead of mutating the caller's object");
	assert.equal((harness.seenOptions[0] as { sessionId?: string }).sessionId, "session-1");

	const stats = new harness.Session("session-1", claude4).getSessionStats();
	// JSON round-trip: records are created inside the VM realm.
	const record = JSON.parse(JSON.stringify(stats.pixAnthropicUsage)) as { modelKey: string; status: number; headers: Record<string, string>; receivedAt: number };
	assert.equal(record.modelKey, "anthropic/claude-4");
	assert.equal(record.status, 200);
	// Only rate-limit headers are retained; credentials never reach the record.
	assert.deepEqual(record.headers, {
		"anthropic-ratelimit-requests-limit": "1000",
		"anthropic-ratelimit-requests-remaining": "250",
		"anthropic-ratelimit-requests-reset": "27s",
	});
	assert.equal(typeof record.receivedAt, "number");
	assert.ok(record.receivedAt > 0);
	assert.equal(JSON.stringify(stats).includes("SECRET"), false);
});

test("Pix RPC skips header capture for subscription sessions and non-Anthropic routes", async () => {
	const harness = await loadAnthropicUsageCapture();
	harness.respond({ status: 200, headers: { "anthropic-ratelimit-requests-limit": "1000", "anthropic-ratelimit-requests-remaining": "1" } });
	const innerCalls: unknown[] = [];
	const options = {
		sessionId: "session-1",
		onResponse: async (response: unknown) => { innerCalls.push(response); },
	};

	// OAuth subscription auth keeps its quota-endpoint path: no capture at all.
	const subscription = new harness.ModelRuntime(true);
	await subscription.streamSimple({ provider: "anthropic", id: "claude-4" }, {}, options);
	assert.equal(harness.seenOptions[0], options, "subscription options pass through untouched");
	assert.equal(innerCalls.length, 1);

	// Non-Anthropic providers and sessionless requests are left alone too.
	const runtime = new harness.ModelRuntime(false);
	await runtime.stream({ provider: "openai", id: "gpt-5" }, {}, options);
	await runtime.streamSimple({ provider: "anthropic", id: "claude-4" }, {}, { onResponse: options.onResponse });
	assert.equal(harness.seenOptions[1], options);
	assert.equal((harness.seenOptions[2] as { sessionId?: string }).sessionId, undefined);
	assert.equal(new harness.Session("session-1", { provider: "anthropic", id: "claude-4" }).getSessionStats().pixAnthropicUsage, undefined);
});

test("Pix RPC isolates captured usage per session and model with bounded history", async () => {
	const harness = await loadAnthropicUsageCapture();
	const runtime = new harness.ModelRuntime(false);
	const claude4 = { provider: "anthropic", id: "claude-4" };
	const claude3 = { provider: "anthropic", id: "claude-3" };
	// Records live in the VM realm; read them through a JSON round-trip.
	const remainingFor = (sessionId: string, model: unknown): string | undefined => {
		const stats = new harness.Session(sessionId, model).getSessionStats();
		if (stats.pixAnthropicUsage === undefined) return undefined;
		const record = JSON.parse(JSON.stringify(stats.pixAnthropicUsage)) as { headers: Record<string, string> };
		return record.headers["anthropic-ratelimit-requests-remaining"];
	};
	const respond = (sessionId: string, model: { provider: string; id: string }, remaining: string) => {
		harness.respond({
			status: 200,
			headers: { "anthropic-ratelimit-requests-remaining": remaining },
		});
		return runtime.streamSimple(model, {}, { sessionId, onResponse: async () => undefined });
	};

	// Concurrent sessions keep independent latest records for the same model.
	await respond("session-1", claude4, "100");
	await respond("session-2", claude4, "900");
	assert.equal(remainingFor("session-1", claude4), "100");
	assert.equal(remainingFor("session-2", claude4), "900");

	// A session's record is only exposed for its CURRENT model; switching
	// models never serves the previous model's snapshot.
	await respond("session-1", claude3, "500");
	assert.equal(remainingFor("session-1", claude3), "500");
	assert.equal(remainingFor("session-2", claude4), "900");
	// Switching back to a model only ever serves that model's own record.
	assert.equal(remainingFor("session-1", claude4), "100");

	// History stays bounded: the oldest route record is evicted beyond 16.
	for (let i = 0; i < 20; i += 1) {
		await respond(`burst-${i}`, claude4, String(i));
	}
	assert.equal(new harness.Session("session-1", claude3).getSessionStats().pixAnthropicUsage, undefined);
	assert.equal(remainingFor("burst-19", claude4), "19");

	// Responses without usable rate-limit headers never create records.
	harness.respond({ status: 500, headers: { "content-type": "application/json" } });
	await runtime.streamSimple(claude4, {}, { sessionId: "session-empty", onResponse: async () => undefined });
	assert.equal(new harness.Session("session-empty", claude4).getSessionStats().pixAnthropicUsage, undefined);
});

test("Pix RPC keeps Anthropic usage alongside the DCP session-stats patch", async () => {
	const source = await readFile(new URL("../src/pi/pix-rpc-entry.js", import.meta.url), "utf8");
	// Start at the DCP stats symbol so both stats patches install in order,
	// and end past parseDcpContextMap like the DCP patch test above.
	const patch = source.slice(
		source.indexOf("const PIX_DCP_RUNTIME_STATS_SYMBOL"),
		source.indexOf("/** @type {WeakMap"),
	);
	const seenOptions: unknown[] = [];
	class ModelRuntime {
		isUsingSubscription() { return false; }
		streamSimple(model: unknown, context: unknown, options: unknown) {
			seenOptions.push(options);
			return (options as { onResponse?: (response: unknown, model: unknown) => unknown }).onResponse?.({
				status: 200,
				headers: { "anthropic-ratelimit-requests-remaining": "424" },
			}, model);
		}
	}
	class Session {
		constructor(sessionId: string, model: unknown) {
			this.sessionId = sessionId;
			this.agent = { state: { model } };
		}
		getSessionStats(): Record<string, unknown> { return { sessionId: this.sessionId }; }
		private readonly sessionId: string;
		readonly agent: { state: { model: unknown } };
	}
	const sandbox = {
		AgentSession: Session,
		ModelRuntime,
		[Symbol.for("pix.dcp.runtime-stats")]: () => ({ tokensSaved: 12 }),
	};
	runInNewContext(patch, sandbox);

	await new ModelRuntime().streamSimple({ provider: "anthropic", id: "claude-4" }, {}, {
		sessionId: "session-both",
		onResponse: async () => undefined,
	});
	const stats = new Session("session-both", { provider: "anthropic", id: "claude-4" }).getSessionStats();
	assert.equal(stats.pixDcpTokensSaved, 12);
	assert.equal(
		(stats.pixAnthropicUsage as { headers: Record<string, string> }).headers["anthropic-ratelimit-requests-remaining"],
		"424",
	);
	assert.equal(seenOptions.length, 1);
});
