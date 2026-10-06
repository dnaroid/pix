import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PiRpcClient } from "../src/pi/pi-rpc-client.js";

test("LSP status crosses the real SDK RPC output guard without an agent turn", { timeout: 45_000 }, async () => {
	const project = fileURLToPath(new URL("../../", import.meta.url));
	const artifacts = path.join(project, ".pi/artifacts");
	await mkdir(artifacts, { recursive: true });
	const workspace = await mkdtemp(path.join(artifacts, "lsp-rpc-"));
	await mkdir(path.join(workspace, ".pi"));
	await writeFile(path.join(workspace, ".pi/pi-tools-suite.jsonc"), '{"lsp":{"servers":[]}}');
	const client = new PiRpcClient({
		piEntry: path.join(project, "acp/src/pi/pix-rpc-entry.js"),
		cwd: workspace,
		args: [
			"--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
			"-e", path.join(project, "external/pi-tools-suite/src/lsp/index.ts"),
		],
		env: {
			HOME: path.join(workspace, "home"), PI_CONFIG_DIR: path.join(workspace, "empty-config"), PI_AGENT_DIR: path.join(workspace, "agent"),
			PI_CODING_AGENT_DIR: path.join(workspace, "agent"),
			NODE_OPTIONS: `--import ${new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href}`,
		},
	});
	const events: unknown[] = [];
	const unsubscribe = client.onEvent((event) => events.push(event));
	try {
		await client.start();
		for (const snapshot of await Promise.all([client.lspControl("status"), client.lspControl("status")])) {
			assert.ok(Array.isArray(snapshot.servers));
			assert.ok(Array.isArray(snapshot.warnings));
			assert.equal(snapshot.trustRequired, false);
			assert.ok(snapshot.servers.every((server) => server.state === "stopped" && server.pid === undefined));
		}
		assert.deepEqual(await client.getMessages(), []);
		assert.equal((await client.getState()).isStreaming, false);
		assert.equal(events.some((event) => ["pix_lsp_response", "agent_start", "message_start"].includes((event as { type: string }).type)), false);
	} finally {
		unsubscribe();
		await client.stop();
		await rm(workspace, { recursive: true, force: true });
	}
});

test("independent Pi RPC sessions monitor edit-started LSPs and last-client ownership", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
	const project = fileURLToPath(new URL("../../", import.meta.url));
	const artifacts = path.join(project, ".pi/artifacts");
	await mkdir(artifacts, { recursive: true });
	const workspace = await mkdtemp(path.join(artifacts, "lsp-rpc-shared-"));
	await mkdir(path.join(workspace, ".pi"));
	await writeFile(path.join(workspace, ".pi/pi-tools-suite.jsonc"), '{"lsp":{"servers":[]}}');
	const home = path.join(workspace, "home");
	const pidLog = path.join(workspace, "server-pids.txt");
	const server = path.join(workspace, "server.cjs");
	await mkdir(path.join(home, ".config/pi"), { recursive: true });
	await writeFile(server, `
const fs = require("node:fs");
fs.appendFileSync(process.argv[2], process.pid + "\\n");
let buffer = Buffer.alloc(0);
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
}
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\\r\\n\\r\\n");
    if (end < 0) return;
    const length = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
    buffer = buffer.subarray(end + 4 + length);
    if (message.method === "exit") process.exit(0);
    if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { capabilities: {} } : null });
  }
});
process.stdin.on("end", () => process.exit(0));
`);
	await writeFile(path.join(home, ".config/pi/pi-tools-suite.jsonc"), JSON.stringify({
		lsp: { servers: [{ id: "rpc-shared", bin: process.execPath, args: [server, pidLog], diagnosticsWaitMs: 0, waitForPublishDiagnostics: false }] },
	}));
	await writeFile(path.join(workspace, "a.ts"), "const a = 1;\n");
	const mutationExtension = path.join(workspace, "mutation-test.ts");
	await writeFile(mutationExtension, `
import { appendLspDiagnosticsToMutationResult } from ${JSON.stringify(path.join(project, "external/pi-tools-suite/src/lsp/index.ts"))};
export default function(pi) {
  pi.registerCommand("test-lsp-edit", { description: "Test successful edit result", handler: async (_, ctx) => {
    await appendLspDiagnosticsToMutationResult({ toolName: "edit", input: { path: "a.ts" }, result: { content: [{ type: "text", text: "ok" }] }, ctx });
  }});
}
`);
	function newClient(): PiRpcClient {
		return new PiRpcClient({
			piEntry: path.join(project, "acp/src/pi/pix-rpc-entry.js"),
			cwd: workspace,
			args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "-e", path.join(project, "external/pi-tools-suite/src/lsp/index.ts"), "-e", mutationExtension],
			env: {
				HOME: home, PI_CONFIG_DIR: path.join(home, "empty-config"), PI_AGENT_DIR: path.join(home, "agent"),
				PI_CODING_AGENT_DIR: path.join(home, "agent"),
				NODE_OPTIONS: `--import ${new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href}`,
			},
		});
	}
	function isAlive(pid: number): boolean {
		try { process.kill(pid, 0); return true; }
		catch { return false; }
	}
	async function waitForExit(pid: number): Promise<void> {
		const deadline = Date.now() + 6_000;
		while (isAlive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
		assert.equal(isAlive(pid), false, `owned LSP PID ${pid} must exit`);
	}
	const first = newClient();
	const second = newClient();
	let serverPid: number | undefined;
	try {
		await Promise.all([first.start(), second.start()]);
		const initial = await second.lspControl("status");
		assert.deepEqual(initial.servers, []);
		await assert.rejects(first.lspControl("start" as "status", "rpc-shared", workspace), /only supports status/);
		await Promise.all([first.prompt("/test-lsp-edit"), second.prompt("/test-lsp-edit")]);
		const starts = await Promise.all([first.lspControl("status"), second.lspControl("status")]);
		serverPid = starts[0].servers.find(row => row.id === "rpc-shared")?.pid;
		assert.ok(serverPid);
		assert.equal(starts[1].servers.find(row => row.id === "rpc-shared")?.pid, serverPid);
		assert.equal((await readFile(pidLog, "utf8")).trim().split("\n").length, 1);
		await first.stop();
		assert.equal((await second.lspControl("status")).servers.find(row => row.id === "rpc-shared")?.pid, serverPid);
		assert.equal(isAlive(serverPid), true);
		await second.prompt("/test-lsp-edit");
		assert.equal((await readFile(pidLog, "utf8")).trim().split("\n").length, 1);
		assert.deepEqual(await second.getMessages(), []);
		assert.equal((await second.getState()).isStreaming, false);
		await second.stop();
		await waitForExit(serverPid);
	} finally {
		await Promise.allSettled([first.stop(), second.stop()]);
		if (serverPid) await waitForExit(serverPid);
		await rm(workspace, { recursive: true, force: true });
	}
});
