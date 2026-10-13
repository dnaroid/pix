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
		_failedResponse: unknown = "pending retry";
		_runSystemPromptOptions = undefined;
		cancelledRetries = 0;
		prompts = 0;
		agent = {
			state: { isStreaming: true, messages: [{ role: "toolResult" }] },
			finishTurn: async (_turn: unknown, _signal?: unknown): Promise<{ action: string } | undefined> => undefined,
			continue: async () => {},
			hasQueuedMessages: () => false,
		};
		_finishCancelledRetry() { this.cancelledRetries++; }
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
		+ "\nglobalThis.control = { bindPause, requestPause, cancelPause, continueSession };", sandbox);
	const control = sandbox.control as {
		bindPause(session: Session): { state: string; pauseBoundaryReached: boolean };
		requestPause(session: Session): void;
		cancelPause(session: Session): void;
		continueSession(session: Session, record: { state: string; pauseBoundaryReached: boolean }): Promise<void>;
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

test("SDK 1.2 continuation clears retry state on abort before post-run work", async () => {
	const { session, control, setPostRun } = pauseFixture();
	const record = control.bindPause(session);
	session.isStreaming = false;
	session.agent.state.isStreaming = false;
	let postRuns = 0;
	setPostRun(async () => { postRuns++; return false; });
	session.agent.continue = async () => { session._agentRunAbortRequested = true; };

	await control.continueSession(session, record);

	assert.equal(postRuns, 0);
	assert.equal(session.cancelledRetries, 1);
	assert.equal(session._failedResponse, undefined);
	assert.equal(record.state, "idle");
});

test("SDK continuation does not start another turn after abort during before-settle", async () => {
	const { session, control, setBeforeSettle } = pauseFixture();
	const record = control.bindPause(session);
	session.isStreaming = false;
	session.agent.state.isStreaming = false;
	let continued = 0;
	session.agent.continue = async () => { continued++; };
	setBeforeSettle(async () => {
		session._agentRunAbortRequested = true;
		return true;
	});

	await control.continueSession(session, record);

	assert.equal(continued, 1);
	assert.equal(session.cancelledRetries, 1);
});

test("continuation failure restores the paused state and permits retry", async () => {
	const { session, control, setBeforeSettle } = pauseFixture();
	const record = control.bindPause(session);
	session.isStreaming = false;
	session.agent.state.isStreaming = false;
	session.agent.continue = async () => { throw new Error("provider failure"); };

	await assert.rejects(control.continueSession(session, record), /provider failure/);
	assert.equal(record.state, "paused");

	session.agent.continue = async () => {};
	setBeforeSettle(async () => false);
	await control.continueSession(session, record);
	assert.equal(record.state, "idle");
});

test("a new run prevents stale continuation from claiming session ownership", async () => {
	const { session, control } = pauseFixture();
	const record = control.bindPause(session);
	let continued = 0;
	session.agent.continue = async () => { continued++; };

	await assert.rejects(control.continueSession(session, record), /another agent run/);
	assert.equal(continued, 0);
	assert.equal(record.state, "paused");
});

test("a scheduled retry stays active until the requested Pause can settle", async () => {
	const { session, control, setPostRun } = pauseFixture();
	const record = control.bindPause(session);
	control.requestPause(session);
	session._failedResponse = { role: "assistant", stopReason: "error" };
	setPostRun(async () => true);

	assert.equal(await session._handlePostAgentRun(), true);
	assert.equal(record.state, "pause-requested");
	assert.deepEqual(session._failedResponse, { role: "assistant", stopReason: "error" });
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
