import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { HEADS_UP_CASES, type EvalCase } from "../scripts/heads-up-eval/cases.js";
import { assess, buildCaseInput, summarize, validateCases, type CaseResult } from "../scripts/heads-up-eval/scoring.js";
import { markdownReport, runCases } from "../scripts/heads-up-eval/runner.js";
import { parseOptions, validateCallBudget } from "../scripts/heads-up-eval/options.js";

const usage: Usage = { input: 20, output: 5, cacheRead: 10, cacheWrite: 0, totalTokens: 35,
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
function message(value: unknown, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
		api: "openai-responses", provider: "test", model: "fixture", stopReason: "stop", timestamp: 0, usage, ...overrides };
}
function reference(testCase: EvalCase): AssistantMessage {
	return message(testCase.expected.kind === "none" ? { kind: "none" } : testCase.expected.reference);
}
function result(testCase: EvalCase, response: AssistantMessage): CaseResult {
	return { caseId: testCase.id, expected: testCase.expected.kind, iteration: 1, inputChars: 10, latencyMs: 2, ...assess(testCase, response) };
}

test("corpus has positive/negative controls and every oracle satisfies its own visible-source rubric", () => {
	validateCases(HEADS_UP_CASES);
	assert.equal(HEADS_UP_CASES.length, 21);
	assert.equal(HEADS_UP_CASES.filter((item) => item.expected.kind === "heads_up").length, 8);
	for (const item of HEADS_UP_CASES) {
		const scored = assess(item, reference(item));
		assert.equal(scored.outcome, item.expected.kind === "none" ? "tn" : "tp", `${item.id}: ${scored.issues.join(", ")}`);
	}
});

test("input uses production redaction/budget and never includes grading labels, rubric or reference answers", () => {
	for (const item of HEADS_UP_CASES) {
		const input = buildCaseInput(item);
		assert.ok(input.body.length <= 16000);
		assert.deepEqual(Object.keys(JSON.parse(input.body)).sort(), ["omitted", "previousNotices", "records"]);
		assert.ok(!input.body.includes(item.rationale));
		assert.doesNotMatch(input.body, /EVAL_(?:SECRET|PRIVATE_THINKING|IMAGE)_CANARY/);
	}
	const long = buildCaseInput(HEADS_UP_CASES.find((item) => item.id === "long-session-api")!);
	assert.ok(long.records.some((item) => item.id === "e01"));
	assert.ok(long.records.some((item) => item.id === "e03"));
	assert.ok(JSON.parse(long.body).omitted > 0);
});

test("always-none cannot pass the eval and undefined precision is not reported as 100 percent", () => {
	const summary = summarize(HEADS_UP_CASES.map((item) => result(item, message({ kind: "none" }))));
	assert.equal(summary.counts.fn, 8); assert.equal(summary.counts.tn, 13);
	assert.equal(summary.recall, 0); assert.equal(summary.precisionProxy, null);
	assert.equal(summary.passed, 13); assert.equal(summary.complete, true);
});

test("always-warning gets false positives; a wrong topic with real IDs is not a positive hit", () => {
	const results = HEADS_UP_CASES.map((item) => result(item, message({ kind: "heads_up", title: "Add more tests", consequence: "It might be useful.", evidenceIds: [buildCaseInput(item).records[0]!.id] })));
	const summary = summarize(results);
	assert.equal(summary.counts.wrong_notice, 8); assert.equal(summary.counts.fp, 13);
	assert.equal(summary.precisionProxy, 0); assert.equal(summary.falsePositiveRate, 1);
});

test("invalid JSON, truncation and invented evidence are failures, never correct silence", () => {
	const negative = HEADS_UP_CASES.find((item) => item.expected.kind === "none")!;
	for (const response of [message("not JSON"), message({ kind: "none", extra: true }), message({ kind: "none" }, { stopReason: "length" }),
		message({ kind: "heads_up", title: "A", consequence: "B", evidenceIds: ["unknown"] })]) {
		assert.equal(assess(negative, response).outcome, "invalid");
		assert.equal(summarize([result(negative, response)]).correctSilenceRate, 0);
	}
});

test("required evidence and consequence anchors are separate and transparent checks", () => {
	const positive = HEADS_UP_CASES[0]!;
	assert.equal(positive.expected.kind, "heads_up");
	if (positive.expected.kind !== "heads_up") return;
	const wrong = assess(positive, message({ ...positive.expected.reference, evidenceIds: ["e01"] }));
	assert.equal(wrong.outcome, "wrong_notice");
	assert.match(wrong.issues[0]!, /missing supporting evidence/);
	const bad = structuredClone(positive); bad.id = "bad-case"; bad.expected = { ...positive.expected, evidenceGroups: [["not-sent"]] };
	assert.throws(() => validateCases([bad]), /clipped out/);
});

test("provider error usage is counted; hidden thinking/raw error messages are not recorded", () => {
	const scored = result(HEADS_UP_CASES[0]!, message({ kind: "none" }, { stopReason: "error", errorMessage: "PRIVATE_TOKEN_FROM_PROVIDER",
		content: [{ type: "thinking", thinking: "PRIVATE_REASONING" }, { type: "text", text: "" }] }));
	assert.equal(scored.outcome, "error"); assert.equal(summarize([scored]).complete, false);
	assert.equal(summarize([scored]).inputTokens, 30); assert.equal(summarize([scored]).reportedCostTotal, 0.3);
	assert.doesNotMatch(JSON.stringify(scored), /PRIVATE/);
});

test("missing usage is distinct from zero reported cost", () => {
	const scored = result(HEADS_UP_CASES[0]!, message({ kind: "none" }, { usage: undefined as unknown as Usage }));
	const summary = summarize([scored]);
	assert.equal(summary.usageCalls, 0); assert.equal(summary.missingUsageCalls, 1);
	assert.equal(summary.inputTokens, 0);
	assert.equal(scored.outcome, "error"); assert.equal(summary.complete, false);
});

test("TypeError and equivalent exception wording count as a config failure anchor", () => {
	const item = HEADS_UP_CASES.find((testCase) => testCase.id === "config-break")!;
	for (const consequence of [
		"Старый конфиг с port вызывает TypeError вместо загрузки.",
		"Legacy port config raises an exception instead of loading.",
		"Старый конфиг с port вызывает исключение.",
	]) assert.equal(assess(item, message({ kind: "heads_up", title: "Config compatibility", consequence, evidenceIds: ["e03"] })).outcome, "tp");
});

test("case/model selection, repeats and total-call ceiling fail closed before inference", () => {
	assert.equal(parseOptions([]).live, false);
	assert.deepEqual(parseOptions(["--model", "a/b", "--model", "c/d"]).models, ["a/b", "c/d"]);
	assert.equal(validateCallBudget(18, parseOptions([])), 18);
	assert.throws(() => validateCallBudget(18, parseOptions(["--repeat", "2"])), /above --max-calls/);
	for (const args of [["--wat"], ["--repeat", "0"], ["--repeat", "6"], ["--max-calls", "NaN"], ["--timeout-ms", "0"], ["--model", "luna"], ["--case"]]) assert.throws(() => parseOptions(args));
});

test("sequential repeats have no accumulated answers or hidden labels", async () => {
	const cases = [HEADS_UP_CASES[0]!, HEADS_UP_CASES.find((item) => item.id === "safe-rename")!];
	let calls = 0; const inputs: string[] = [];
	const results = await runCases({ cases, repeat: 2, timeoutMs: 1000, infer: async (input) => {
		inputs.push(input); return reference(cases[calls++ % cases.length]!);
	} });
	assert.equal(results.length, 4); assert.equal(summarize(results).passed, 4);
	assert.equal(inputs[0], inputs[2]); assert.equal(inputs[1], inputs[3]);
});

test("timeout aborts transport, stops the batch, and cannot overlap an abort-ignoring request", async () => {
	let signal: AbortSignal | undefined; let calls = 0;
	const results = await runCases({ cases: HEADS_UP_CASES.slice(0, 3), repeat: 1, timeoutMs: 5,
		infer: (_input, requestSignal) => { calls++; signal = requestSignal; return new Promise(() => {}); } });
	assert.equal(calls, 1); assert.equal(signal?.aborted, true);
	assert.deepEqual(results.map((item) => item.outcome), ["timeout", "not_run", "not_run"]);
	assert.equal(summarize(results).passed, 0);
});

test("synchronous throws stop later model calls; raw errors are not copied", async () => {
	const results = await runCases({ cases: HEADS_UP_CASES.slice(0, 2), repeat: 1, timeoutMs: 1000,
		infer: () => { throw new Error("secret-provider-error"); } });
	assert.deepEqual(results.map((item) => item.outcome), ["error", "not_run"]);
	assert.doesNotMatch(JSON.stringify(results), /secret-provider-error/);
});

test("already cancelled run never calls a model or claims passes", async () => {
	const abort = new AbortController(); abort.abort();
	const results = await runCases({ cases: HEADS_UP_CASES, repeat: 1, timeoutMs: 1000, signal: abort.signal,
		infer: async () => { throw new Error("must not run"); } });
	assert.equal(summarize(results).attempted, 0); assert.equal(summarize(results).complete, false);
});

test("reports include all outputs and the heuristic/coverage/cost caveats, not just failures", () => {
	const results = HEADS_UP_CASES.map((item) => result(item, reference(item)));
	const text = markdownReport([{ model: "fixture/test", results }], HEADS_UP_CASES);
	assert.match(text, /not a held-out/); assert.match(text, /manually inspect/i); assert.match(text, /Zero reported cost/);
	assert.match(text, /api-break \/ 1: tp/); assert.match(text, /new-task \/ 1: tn/);
	assert.equal(summarize(results).recall, 1); assert.equal(summarize(results).precisionProxy, 1);
});

test("CLI default is offline and PI_OFFLINE blocks live before provider runtime creation", async () => {
	const run = promisify(execFile);
	const cli = ["--import", "tsx", "scripts/heads-up-eval/run.ts"];
	const dry = await run(process.execPath, [...cli, "--case", "api-break"], { timeout: 10000 });
	assert.match(dry.stdout, /No model requests/); assert.doesNotMatch(dry.stdout, /Live eval:/);
	await assert.rejects(run(process.execPath, [...cli, "--live"], { timeout: 10000, env: { ...process.env, PI_OFFLINE: "yes" } }), (error: unknown) => {
		const failed = error as Error & { code: number; stderr: string; stdout: string };
		assert.equal(failed.code, 2); assert.match(failed.stderr, /PI_OFFLINE/); assert.doesNotMatch(failed.stdout, /Live eval:/); return true;
	});
	await assert.rejects(run(process.execPath, [...cli, "--live", "--case", "typo"], { timeout: 10000 }), /Unknown case/);
});
