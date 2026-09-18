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
