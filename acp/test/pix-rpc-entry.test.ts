import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

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
		async prompt(_text: string, _options?: { preflightResult: (ok: boolean) => void }): Promise<void> {
			assert.fail("clear must not enter normal prompt dispatch");
		}
	}
	const sentinel = "\u0000pix:clear-todos";
	runInNewContext(patch, {
		AgentSession: Session, PIX_CLEAR_TODOS_MESSAGE: sentinel,
		PIX_PAUSE_MESSAGE: "pause", PIX_CONTINUE_MESSAGE: "continue",
		bindPause() { assert.fail("clear must not bind a model run"); },
	});
	const acknowledgements: boolean[] = [];
	const options = { preflightResult: (ok: boolean) => acknowledgements.push(ok) };
	const session = new Session();
	const pending = session.prompt(sentinel, options);
	assert.equal(calls, 1);
	assert.deepEqual(acknowledgements, []);
	release();
	await pending;
	assert.deepEqual(acknowledgements, [true]);
	gate = undefined;
	handlerError = new Error("snapshot failed");
	await assert.rejects(session.prompt(sentinel, options), /snapshot failed/u);
	idle = false;
	await assert.rejects(session.prompt(sentinel, options), /session is busy/u);
	assert.equal(calls, 2, "busy rejection must not run the handler");
	command = undefined;
	await assert.rejects(session.prompt(sentinel, options), /Todo extension is unavailable/u);
	assert.deepEqual(acknowledgements, [true], "failed requests must never report success");
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
