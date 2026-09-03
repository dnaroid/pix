import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { resolveAdapterConfig } from "../dist/config.js";
import { PiRpcClient } from "../dist/pi/pi-rpc-client.js";

const scratch = mkdtempSync(join(tmpdir(), "pix-acp-stdio-"));
await verifyDefaultPiEntry();
const child = spawn(process.execPath, ["dist/main.js"], {
	cwd: process.cwd(),
	env: {
		...process.env,
		PIX_ACP_LOG: "error",
		PIX_ACP_PI_ENTRY: fileURLToPath(new URL("./fixtures/fake-pi-rpc.mjs", import.meta.url)),
		PIX_ACP_SESSION_MAP: join(scratch, "sessions.json"),
	},
	stdio: ["pipe", "pipe", "pipe"],
});
const output = createInterface({ input: child.stdout });
const messages = [];
const waiters = new Set();
output.on("line", (line) => {
	const message = JSON.parse(line);
	messages.push(message);
	for (const waiter of [...waiters]) waiter(message);
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
	stderr += chunk;
});

try {
	send({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {},
			clientInfo: { name: "pix-acp-stdio-smoke", version: "0" },
		},
	});

	const response = await withTimeout(
		Promise.race([
			waitForMessage((message) => message.id === 1),
			once(child, "exit").then(([code, signal]) => {
				throw new Error(`pix-acp exited before initialize response (${code ?? signal}): ${stderr}`);
			}),
		]),
		5_000,
		"pix-acp initialize response",
	);
	assert.equal(response.id, 1);
	assert.equal(response.error, undefined);
	assert.equal(response.result?.protocolVersion, PROTOCOL_VERSION);
	assert.equal(response.result?.agentCapabilities?.loadSession, true);

	send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: scratch, mcpServers: [] } });
	const created = await withTimeout(waitForMessage((message) => message.id === 2), 5_000, "session/new response");
	assert.equal(created.error, undefined, JSON.stringify(created.error));
	assert.equal(typeof created.result?.sessionId, "string");

	send({
		jsonrpc: "2.0",
		id: 3,
		method: "session/prompt",
		params: { sessionId: created.result.sessionId, prompt: [{ type: "text", text: "hello" }] },
	});
	const prompted = await withTimeout(waitForMessage((message) => message.id === 3), 5_000, "session/prompt response");
	assert.equal(prompted.result?.stopReason, "end_turn");
	assert.ok(
		messages.some(
			(message) =>
				message.method === "session/update" &&
				message.params?.update?.sessionUpdate === "agent_message_chunk" &&
				message.params?.update?.content?.text === "fake reply",
		),
		"prompt streamed the fake pi reply",
	);

	send({ jsonrpc: "2.0", id: 4, method: "session/close", params: { sessionId: created.result.sessionId } });
	const closed = await withTimeout(waitForMessage((message) => message.id === 4), 5_000, "session/close response");
	assert.equal(closed.error, undefined);

	child.stdin.end();
	const [code, signal] = await withTimeout(once(child, "exit"), 5_000, "pix-acp clean shutdown");
	assert.equal(signal, null);
	assert.equal(code, 0, stderr);
	console.log("pix-acp dist stdio session flow: ok");
} finally {
	output.close();
	if (child.exitCode === null && child.signalCode === null) child.kill();
	rmSync(scratch, { recursive: true, force: true });
}

function send(message) {
	child.stdin.write(`${JSON.stringify(message)}\n`);
}

function waitForMessage(predicate) {
	const existing = messages.find(predicate);
	if (existing) return Promise.resolve(existing);
	return new Promise((resolve) => {
		const waiter = (message) => {
			if (!predicate(message)) return;
			waiters.delete(waiter);
			resolve(message);
		};
		waiters.add(waiter);
	});
}

async function withTimeout(promise, timeoutMs, label) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function verifyDefaultPiEntry() {
	const pi = new PiRpcClient({ piEntry: resolveAdapterConfig().piEntry, cwd: scratch });
	try {
		await withTimeout(pi.start(), 5_000, "default pi RPC entry startup");
		const state = await withTimeout(pi.getState(), 5_000, "default pi RPC get_state");
		assert.equal(typeof state.sessionId, "string");
	} finally {
		await pi.stop();
	}
}
