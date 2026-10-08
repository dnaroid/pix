import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { PiRpcClient } from "../src/pi/pi-rpc-client.js";

const source = readFileSync(new URL("../src/pi/pix-rpc-entry.js", import.meta.url), "utf8");

function pauseFixture() {
	let postRun = async () => false;
	let beforeSettle = async () => true;
	class Session {
		isStreaming = true;
		_isAgentRunActive = true;
		_agentRunAbortRequested = false;
		_runSystemPromptOptions = undefined;
		prompts = 0;
		agent = {
			state: { isStreaming: true, messages: [{ role: "toolResult" }] },
			finishTurn: async (_turn: unknown, _signal?: unknown): Promise<{ action: string } | undefined> => undefined,
			hasQueuedMessages: () => false,
		};
		subscribe() { return () => {}; }
		async _handlePostAgentRun() { return postRun(); }
		async _runBeforeSettleBoundary() { return beforeSettle(); }
		_flushPendingBashMessages() {}
		_flushPendingCustomMessages() {}
		async _emitAgentSettled() {}
		async prompt(_text: string, _options?: { preflightResult?: (result: string) => void }) { this.prompts++; }
	}
	const sandbox = vm.createContext({
		AgentSession: Session,
		PIX_BTW_RPC_PREFIX: "btw:", PIX_PAUSE_MESSAGE: "pause", PIX_CANCEL_PAUSE_MESSAGE: "cancel-pause",
		PIX_CONTINUE_MESSAGE: "continue", PIX_CLEAR_TODOS_MESSAGE: "clear", PIX_LSP_CONTROL_PREFIX: "lsp:",
	});
	vm.runInContext(source.slice(source.indexOf("const records = new WeakMap();"),
		source.indexOf("// --- Quota-wait hidden control messages"))
		+ source.slice(source.indexOf("const originalPrompt = AgentSession.prototype.prompt;"), source.indexOf("const { main } ="))
		+ "\nglobalThis.control = { bindPause, requestPause, cancelPause };", sandbox);
	const control = sandbox.control as {
		bindPause(session: Session): { state: string; pauseBoundaryReached: boolean };
		requestPause(session: Session): void;
		cancelPause(session: Session): void;
	};
	return { session: new Session(), control,
		setPostRun(hook: () => Promise<boolean>) { postRun = hook; },
		setBeforeSettle(hook: () => Promise<boolean>) { beforeSettle = hook; } };
}

const turn = { message: { stopReason: "toolUse" } };

test("private cancellation clears pending Pause before the turn decision without sending a prompt", async () => {
	const { session, control, setPostRun } = pauseFixture();
	const record = control.bindPause(session);
	control.requestPause(session);
	let preflight: string | undefined;
	await session.prompt("cancel-pause", { preflightResult: (result) => { preflight = result; } });
	assert.equal(preflight, "handled");
	assert.equal(record.state, "idle");
	assert.equal(session.prompts, 0);
	assert.equal(session.isStreaming, true);
	assert.equal(await session.agent.finishTurn(turn), undefined);
	setPostRun(async () => true);
	assert.equal(await session._handlePostAgentRun(), true, "normal loop continuation is preserved");
});

test("committed Pause stays locked across post-run and before-settle awaits", async () => {
	const { session, control, setBeforeSettle } = pauseFixture();
	const record = control.bindPause(session);
	control.requestPause(session);
	assert.equal((await session.agent.finishTurn(turn))?.action, "end");
	assert.throws(() => control.cancelPause(session), /pause boundary/);
	assert.equal(await session._handlePostAgentRun(), false);
	assert.throws(() => control.cancelPause(session), /pause boundary/);
	let release!: (value: boolean) => void;
	setBeforeSettle(() => new Promise<boolean>((resolve) => { release = resolve; }));
	const settling = session._runBeforeSettleBoundary();
	assert.throws(() => control.cancelPause(session), /pause boundary/);
	release(true);
	assert.equal(await settling, false);
	assert.equal(record.state, "paused");
	assert.throws(() => control.cancelPause(session), /pause boundary/);
	let preflight = false;
	await assert.rejects(session.prompt("cancel-pause", { preflightResult: () => { preflight = true; } }), /pause boundary/);
	assert.equal(preflight, false, "committed cancellation must not be reported as handled");
	assert.equal(session.prompts, 0);
});

test("cancellation during uncommitted post-run work preserves its continuation decision", async () => {
	const { session, control, setPostRun } = pauseFixture();
	const record = control.bindPause(session);
	control.requestPause(session);
	let release!: (value: boolean) => void;
	setPostRun(() => new Promise<boolean>((resolve) => { release = resolve; }));
	const postRun = session._handlePostAgentRun();
	control.cancelPause(session);
	release(true);
	assert.equal(await postRun, true);
	assert.equal(record.state, "idle");
});

test("Pi cancellation transport uses a private sentinel and propagates boundary failures", async () => {
	const client = new PiRpcClient({ piEntry: "/unused", cwd: "/tmp" });
	await assert.rejects(client.cancelPause(), /before start\(\)/);
	const sent: unknown[] = [];
	let response: unknown = { type: "response", command: "prompt", success: true, data: { disposition: "handled" } };
	const sdk = Object.create(RpcClient.prototype);
	sdk.send = async (command: unknown) => { sent.push(command); return response; };
	(client as unknown as { client: RpcClient }).client = sdk;
	await client.cancelPause();
	assert.equal(sent.length, 1);
	assert.equal((sent[0] as { type: string }).type, "prompt");
	assert.equal((sent[0] as { message: string }).message, "\u0000pix:agent-control:cancel-pause");
	response = { type: "response", command: "prompt", success: false, error: "Agent has already reached the pause boundary" };
	await assert.rejects(client.cancelPause(), /pause boundary/);
});
