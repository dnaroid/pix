import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRpcStartupProgress, rpcStartupFailure, traceRpcStartup } from "../src/pi/startup-diagnostics.js";

test("startup tracing preserves results/errors even when the diagnostic sink fails", async () => {
	const records: string[] = [];
	const result = await traceRpcStartup("resources", async () => 42, (record) => records.push(formatRpcStartupProgress(record)));
	assert.equal(result, 42);
	assert.match(records[0]!, /"status":"started"/u);
	assert.match(records[1]!, /"status":"completed"/u);
	const original = new Error("original failure");
	await assert.rejects(traceRpcStartup("session-start", async () => { throw original; }, () => { throw new Error("sink"); }),
		(error) => error === original);
});

test("readiness failure identifies the unfinished stage, ignoring malformed/untrusted metadata", () => {
	const line = (stage: "resources" | "model-runtime", status: "started" | "completed") =>
		formatRpcStartupProgress({ stage, status, elapsedMs: 1 });
	const cause = new Error("Timeout waiting for response to get_state");
	const error = rpcStartupFailure(cause, line("resources", "started") + line("model-runtime", "started")
		+ line("model-runtime", "completed") + '[pix-startup] {"stage":"secret","status":"started","elapsedMs":1}\n'
		+ '[pix-startup] malformed\n');
	assert.match(error.message, /Timeout waiting for response to get_state; startup stage: resources$/u);
	assert.equal((error as Error & { cause?: unknown }).cause, cause);
	assert.doesNotMatch(error.message, /secret|malformed/u);
	assert.match(rpcStartupFailure(cause, line("resources", "started") + line("resources", "completed")).message,
		/last startup stage: resources \(completed, 1ms\)/u);
	assert.equal(rpcStartupFailure(cause, "unrelated stderr").message, `Pi RPC readiness failed: ${cause.message}`);
});
