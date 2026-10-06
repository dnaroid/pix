import assert from "node:assert/strict";
import { test } from "node:test";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { PiRpcClient } from "../src/pi/pi-rpc-client.js";

test("todo clear uses the private sentinel and propagates SDK failure responses", async () => {
	const client = new PiRpcClient({ piEntry: "/unused", cwd: "/tmp" });
	await assert.rejects(client.clearTodos(), /before start\(\)/u);
	const sent: unknown[] = [];
	let response: unknown = { type: "response", command: "prompt", success: true };
	// Keep the installed SDK response decoder; stub only subprocess transport.
	const sdk = Object.create(RpcClient.prototype);
	sdk.send = async (command: unknown) => { sent.push(command); return response; };
	(client as unknown as { client: RpcClient }).client = sdk;
	await client.clearTodos();
	assert.deepEqual(sent, [{ type: "prompt", message: "\u0000pix:clear-todos" }]);
	response = { type: "response", command: "prompt", success: false, error: "Todo extension is unavailable" };
	await assert.rejects(client.clearTodos(), /Todo extension is unavailable/u);
});

test("LSP control uses a correlated hidden prompt and rejects missing snapshots", async () => {
	const client = new PiRpcClient({ piEntry: "/unused", cwd: "/tmp" });
	const sent: unknown[] = [];
	const listeners = new Set<(event: unknown) => void>();
	let response: unknown = { type: "response", command: "prompt", success: true };
	const sdk = Object.create(RpcClient.prototype) as RpcClient & {
		send(command: unknown): Promise<unknown>;
		onEvent(listener: (event: unknown) => void): () => void;
		getData<T>(data: unknown): T;
	};
	sdk.send = async (command: unknown) => {
		sent.push(command);
		const text = (command as { message: string }).message;
		const payload = JSON.parse(text.slice("\u0000pix:lsp-control:".length)) as { requestId: string };
		for (const listener of listeners) listener({ type: "pix_lsp_response", requestId: payload.requestId,
			snapshot: { servers: [{ id: "ts", root: "/workspace", state: "running" }], warnings: [] } });
		return response;
	};
	sdk.onEvent = (listener: (event: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); };
	sdk.getData = <T>(data: unknown) => {
		if ((data as { success?: boolean }).success === false) throw new Error((data as { error: string }).error);
		return undefined as T;
	};
	(client as unknown as { client: RpcClient }).client = sdk;
	await assert.rejects(client.lspControl("start" as "status", "ts", "/workspace"), /only supports status/u);
	assert.equal(sent.length, 0, "mutation is rejected before any SDK request or listener");
	assert.equal(listeners.size, 0);
	assert.deepEqual(await client.lspControl("status"), {
		servers: [{ id: "ts", root: "/workspace", state: "running" }], warnings: [],
	});
	assert.equal((sent[0] as { message: string }).message.startsWith("\u0000pix:lsp-control:"), true);
	assert.equal(listeners.size, 0, "event listener is removed after completion");
	sdk.send = async (command: unknown) => { sent.push(command); return response; };
	await assert.rejects(client.lspControl("status"), /no correlated snapshot/u);
	response = { type: "response", command: "prompt", success: false, error: "command failed" };
	await assert.rejects(client.lspControl("status"), /command failed/u);
});
