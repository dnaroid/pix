import assert from "node:assert/strict";
import { test } from "node:test";
import { pixLogger } from "../src/app/logger.js";
import { logOperationFailure } from "../src/app/logging/operation-errors.js";
import { withCliDiagnostics } from "../src/app/cli/diagnostics.js";

test("handled failures retain context, classify cancellation and omit arbitrary thrown payloads", (t) => {
	const log = t.mock.method(pixLogger, "log", async () => {});
	const context = { project: "/projects/original", sessionId: "original", module: "test" };
	const error = new Error("failure");
	logOperationFailure("operation:failed", error, context);
	logOperationFailure("operation:cancelled", new DOMException("cancelled", "AbortError"), context);
	logOperationFailure("operation:payload", { prompt: "PRIVATE INPUT" }, context);
	assert.deepEqual(log.mock.calls.map(call => call.arguments[0]), ["error", "debug", "error"]);
	assert.equal(log.mock.calls[0]!.arguments[2].error, error);
	assert.deepEqual(log.mock.calls[0]!.arguments[3], context);
	assert.equal(log.mock.calls[1]!.arguments[2].cancelled, true);
	assert.doesNotMatch(JSON.stringify(log.mock.calls), /PRIVATE INPUT/);
});

test("CLI diagnostics flush on success and preserve the original rejection even with a broken log sink", async (t) => {
	const flush = t.mock.method(pixLogger, "flush", async () => {});
	t.mock.method(pixLogger, "log", () => { throw new Error("broken sink"); });
	assert.equal(await withCliDiagnostics("install", async () => 1), 1);
	const original = new Error("original");
	await assert.rejects(withCliDiagnostics("update", async () => { throw original; }), error => error === original);
	assert.equal(flush.mock.callCount(), 2);
});
