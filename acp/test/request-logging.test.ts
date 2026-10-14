import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { withLoggedRequest } from "../src/acp/request-logging.js";
import type { Logger } from "../src/logging.js";

test("every registered ACP request logs its actual method, not session/cancel", () => {
	const source = readFileSync(new URL("../src/acp/pix-acp-agent.ts", import.meta.url), "utf8");
	const lines = source.split("\n").filter(line => line.includes(".onRequest(") && line.includes("this.withRequestLogging("));
	assert.ok(lines.length >= 50, "Check the full ACP request registry when registration shape changes");
	for (const line of lines) {
		const registration = /\.onRequest\(("[^"]+"|[A-Z][A-Z0-9_]+)\s*,/.exec(line)?.[1];
		const logged = /this\.withRequestLogging\(("[^"]+"|[A-Z][A-Z0-9_]+)\s*,/.exec(line)?.[1];
		assert.ok(registration && logged, "Cannot verify request logging attribution for " + line.trim());
		assert.equal(logged, registration);
	}
	assert.match(source, /\.onNotification\("session\/cancel", \(ctx\) => this\.withRequestLogging\("session\/cancel"/);
});

test("request failures preserve identity, classify cancellation/validation, omit validation payloads", async () => {
	const calls: unknown[][] = [];
	const logger = Object.fromEntries(["debug", "info", "warn", "error"].map(level => [level, (...args: unknown[]) => calls.push([level, ...args])])) as unknown as Logger;
	const context = { project: "/projects/original", sessionId: "original", module: "requests" };
	const signal = new AbortController().signal;
	const failures = [new Error("failure"), new RequestError(-32602, "PRIVATE INPUT", { prompt: "PRIVATE INPUT" }), new DOMException("cancelled", "AbortError"), { prompt: "PRIVATE INPUT" }];
	for (const failure of failures) {
		await assert.rejects(withLoggedRequest(logger, "session/prompt", context, signal, () => { throw failure; }), error => error === failure);
	}
	assert.deepEqual(calls.map(call => call[0]), ["error", "warn", "debug", "error"]);
	assert.ok(calls.every(call => call[2] === context));
	assert.doesNotMatch(JSON.stringify(calls), /PRIVATE INPUT/);
	assert.equal(await withLoggedRequest(logger, "ok", context, signal, () => 42), 42);
	assert.equal(calls.length, 4);
});

test("aborted request is debug and failing diagnostics cannot replace its error", async () => {
	const levels: string[] = [];
	const logger = Object.fromEntries(["debug", "info", "warn", "error"].map(level => [level, () => { levels.push(level); throw new Error("sink"); }])) as unknown as Logger;
	const controller = new AbortController(); controller.abort();
	const error = new Error("original");
	await assert.rejects(withLoggedRequest(logger, "cancelled", { project: null, module: "requests" }, controller.signal, async () => { throw error; }), value => value === error);
	assert.deepEqual(levels, ["debug"]);
});
