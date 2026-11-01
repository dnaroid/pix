import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { RpcClient } from "@earendil-works/pi-coding-agent";
import { attachJsonlReader } from "../src/pi/jsonl-reader.js";
import { startRpcClient } from "../src/pi/rpc-stdout.js";

test("stdout replacement precedes asynchronous startup output and retains a partial event across start", async () => {
	const stdout = new Readable({ read() {} });
	const lines: string[] = [];
	const client = {
		process: { stdout },
		stopReadingStdout: () => {},
		handleLine(line: string) { assert.equal(this, client); lines.push(line); },
		async start() {
			this.stopReadingStdout = attachJsonlReader(stdout, (line) => this.handleLine(line));
			await Promise.resolve();
			stdout.emit("data", '{"type":"startup",');
		},
		async stop() { this.stopReadingStdout(); },
	};
	await startRpcClient(client as unknown as RpcClient);
	stdout.emit("data", '"text":"ready"}\n');
	assert.deepEqual(lines, ['{"type":"startup","text":"ready"}']);
	assert.equal(stdout.listenerCount("data"), 1);
	await client.stop();
	assert.equal(stdout.listenerCount("data"), 0);
	assert.equal(stdout.listenerCount("end"), 0);
	assert.equal(stdout.listenerCount("close"), 0);
});

test("incompatible SDK startup is rejected and stopped, including an asynchronous startup rejection", async () => {
	for (const rejectStartup of [false, true]) {
		let stops = 0;
		const client = {
			async start() { if (rejectStartup) throw new Error("startup failed"); },
			async stop() { stops++; },
		};
		await assert.rejects(startRpcClient(client as unknown as RpcClient), /SDK startup compatibility/);
		assert.equal(stops, 1);
	}
});

test("startup rejection releases the replacement reader and preserves the original error", async () => {
	const stdout = new Readable({ read() {} });
	const failure = new Error("startup failed");
	let stops = 0;
	const client = {
		process: { stdout },
		stopReadingStdout: () => {},
		handleLine() {},
		async start() { await Promise.resolve(); throw failure; },
		async stop() { stops++; this.stopReadingStdout(); },
	};
	await assert.rejects(startRpcClient(client as unknown as RpcClient), (error) => error === failure);
	assert.equal(stops, 1);
	assert.equal(stdout.listenerCount("data"), 0);
	assert.equal(stdout.listenerCount("end"), 0);
	assert.equal(stdout.listenerCount("close"), 0);
});
