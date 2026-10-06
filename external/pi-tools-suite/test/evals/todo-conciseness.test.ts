import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { deriveMetrics } from "./harness/metrics.js";
import { resolveEvalOutputDir } from "./harness/output-dir.js";
import type { EvalEvent, EvalRunResult } from "./harness/types.js";
import { scoreTodoConciseness, TODO_CONCISENESS_CASES } from "./todo-conciseness.js";
import { createTodoPromptSnapshots, previousTodoPrompt } from "./todo-prompt-snapshots.js";

function fixture(stage: string): EvalRunResult {
	const inputs: Record<string, unknown>[] = [{ action: "batch_create", items: [
		{ subject: "Verify checkout retry", description: "Acceptance: no duplicate charge after retry.", status: "in_progress", activeForm: "Checking retry" },
		{ subject: "Give final report", status: "pending" },
	] }];
	if (stage === "verification" || stage === "completion") inputs.push({ action: "update", id: 1, status: "in_progress", description: "No duplicate charge after retry; focused and full tests passed. Awaiting sign-off.", activeForm: "Awaiting sign-off" });
	if (stage === "blocked") inputs.push({ action: "update", id: 1, status: "deferred", description: "No duplicate charge after retry; waiting for user approval." });
	if (stage === "completion") inputs.push(
		{ action: "batch_update", items: [{ id: 1, status: "completed" }, { id: 2, status: "in_progress", activeForm: "Reporting results" }] },
		{ action: "update", id: 2, status: "completed" },
	);
	const events: EvalEvent[] = inputs.flatMap((input, index) => [
		{ type: "tool_call", toolName: "todo", toolCallId: `call-${index}`, input },
		{ type: "tool_result", toolName: "todo", toolCallId: `call-${index}`, isError: false },
	]);
	return {
		caseId: `tool.todo-concise-${stage}`, model: "fixture", projectDir: "/missing", stdout: "", stderr: "", exitCode: 0, timedOut: false, events,
		metrics: deriveMetrics({ events, elapsedMs: 1, changedFiles: [], projectDir: "/missing", sessionDir: "/missing" }), assertions: [], passed: false,
	};
}

describe("todo conciseness eval controls", () => {
	for (const description of [
		"Verify that retrying checkout does not cause a duplicate charge.",
		"Prevent duplicate charges after retry.",
		"Avoid a duplicate charge after retry.",
	]) test(`preserves equivalent acceptance criterion: ${description}`, () => {
		const result = fixture("create");
		(result.events[0]!.input as { items: { description: string }[] }).items[0]!.description = description;
		expect(scoreTodoConciseness(result, "create").lifecycleErrors).toEqual([]);
	});
	test("rejects duplicate-charge wording without the negative acceptance criterion", () => {
		const result = fixture("create");
		(result.events[0]!.input as { items: { description: string }[] }).items[0]!.description = "Retry can cause a duplicate charge.";
		expect(scoreTodoConciseness(result, "create").lifecycleErrors.join(" ")).toContain("criterion was lost");
	});
	test("rescores finalized events without new live calls and preserves original evidence", () => {
		const artifacts = resolveEvalOutputDir("todo-rescore-controls");
		fs.mkdirSync(artifacts, { recursive: true });
		const original = { startedAt: "fixture", complete: true, repeats: 1, models: ["fixture"], rows: [{
			model: "fixture", repeat: 1, variant: "brief", caseId: "tool.todo-concise-completion",
			executionOk: true, brevity: false, lifecycle: false, maxDescription: 100,
			brevityErrors: ["old"], lifecycleErrors: ["old"], result: fixture("completion"),
		}] };
		fs.writeFileSync(path.join(artifacts, "comparison.json"), JSON.stringify(original));
		const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "run-todo-paired.ts");
		const run = () => spawnSync(process.execPath, [runner], { env: { ...process.env, PI_TODO_EVAL_RESCORE_DIR: artifacts }, encoding: "utf8" });
		expect(run().status).toBe(0);
		const rescored = JSON.parse(fs.readFileSync(path.join(artifacts, "comparison.json"), "utf8"));
		expect(rescored.rows[0].brevity).toBe(true);
		expect(rescored.rows[0].lifecycle).toBe(true);
		expect(rescored.rows[0].result).toEqual(original.rows[0]!.result);
		expect(JSON.parse(fs.readFileSync(path.join(artifacts, "raw-live-comparison.json"), "utf8"))).toEqual(original);
		fs.writeFileSync(path.join(artifacts, "comparison.json"), JSON.stringify({ ...original, complete: false }));
		expect(run().status).not.toBe(0);
	});
	test("freezes exact variants without changing source and fails closed on prompt drift", () => {
		const artifacts = resolveEvalOutputDir("todo-snapshot-controls");
		const root = path.join(artifacts, "package");
		const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
		const files = ["src/tool-descriptions.ts", "src/todo/tool/types.ts"];
		for (const file of files) {
			fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			fs.copyFileSync(path.join(source, file), path.join(root, file));
		}
		fs.writeFileSync(path.join(root, "index.ts"), "export default () => {};\n");
		fs.mkdirSync(path.join(root, "node_modules"));
		const entries = createTodoPromptSnapshots(root, path.join(artifacts, "run"));
		for (const file of files) {
			const original = fs.readFileSync(path.join(source, file), "utf8");
			expect(fs.readFileSync(path.join(root, file), "utf8")).toBe(original);
			expect(fs.readFileSync(path.join(path.dirname(entries.strengthened), file), "utf8")).toBe(original);
			expect(fs.readFileSync(path.join(path.dirname(entries.brief), file), "utf8")).toBe(previousTodoPrompt(file, original));
			expect(() => previousTodoPrompt(file, "changed prompt")).toThrow();
		}
		expect(() => createTodoPromptSnapshots(root, path.join(artifacts, "run"))).toThrow();
	});
	test("scores brevity and lifecycle independently", () => {
		const verbose = fixture("completion");
		(verbose.events[2]!.input as Record<string, unknown>).description = `No duplicate charge; tests passed. ${"x".repeat(241)}`;
		const scores = scoreTodoConciseness(verbose, "completion");
		expect(scores.brevityErrors.length).toBeGreaterThan(0);
		expect(scores.lifecycleErrors).toEqual([]);
		const invalid = fixture("completion");
		invalid.events.splice(2, 2);
		expect(scoreTodoConciseness(invalid, "completion").brevityErrors).toEqual([]);
		expect(scoreTodoConciseness(invalid, "completion").lifecycleErrors.length).toBeGreaterThan(0);
	});
	test("accepts initial replace on an empty plan, but rejects later replacement", () => {
		const result = fixture("completion");
		(result.events[0]!.input as Record<string, unknown>).replace = true;
		expect(scoreTodoConciseness(result, "completion").lifecycleErrors).toEqual([]);
		const repeated = { ...result.events[0]!, toolCallId: "replacement" };
		result.events.splice(2, 0, repeated, { type: "tool_result", toolName: "todo", toolCallId: "replacement", isError: false });
		expect(scoreTodoConciseness(result, "completion").lifecycleErrors.length).toBeGreaterThan(0);
	});
	for (const checkpoint of [
		"Focused tests 18/18, full tests 205/205; typecheck exit 0.",
		"Tests are green; awaiting approval.",
		"Successful focused and full tests; awaiting sign-off.",
		"Tests: 18/18 and 205/205, supplied results, not independently performed verification.",
	]) {
		test(`accepts equivalent checkpoint: ${checkpoint}`, () => {
			const result = fixture("completion");
			(result.events[2]!.input as Record<string, unknown>).description = `No duplicate charge; ${checkpoint}`;
			expect(TODO_CONCISENESS_CASES[3]!.validate!(result)).toEqual([]);
		});
	}
	for (const checkpoint of [
		"Tests have not passed.", "Tests did not pass.", "Tests pending.", "Tests not run.",
		"Focused tests 17/18, full tests 205/205.", "Tests 0/0.", "Tests passed with 1 failure.",
		"Tests 18/18; typecheck exit 1.", "Tests unverified.", "Tests failed after earlier passing tests.",
		"Typecheck exit 0; diff-check exit 0.",
		"Tests are not green.", "Tests not successful.", "Tests didn't pass.", "Tests will pass.",
	]) {
		test(`rejects unsuccessful or absent checkpoint: ${checkpoint}`, () => {
			const result = fixture("completion");
			(result.events[2]!.input as Record<string, unknown>).description = `No duplicate charge; ${checkpoint}`;
			expect(scoreTodoConciseness(result, "completion").lifecycleErrors.length).toBeGreaterThan(0);
		});
	}
	test("rejects final statuses reached in the wrong order", () => {
		const result = fixture("completion");
		(result.events[4]!.input as { items: Record<string, unknown>[] }).items.reverse();
		expect(scoreTodoConciseness(result, "completion").lifecycleErrors.length).toBeGreaterThan(0);
	});
	for (const evalCase of TODO_CONCISENESS_CASES) {
		const stage = evalCase.id.replace("tool.todo-concise-", "");
		test(`${stage}: accepts short text and correct lifecycle`, () => {
			expect(evalCase.validate!(fixture(stage))).toEqual([]);
		});
		test(`${stage}: rejects narration, failed/missing/duplicate results and non-todo calls`, () => {
			for (const mutation of ["narration", "failed", "missing", "duplicate", "other-tool"]) {
				const result = fixture(stage);
				if (mutation === "narration") { result.events = []; result.stdout = "All plan updates done."; }
				if (mutation === "failed") result.events[1]!.isError = true;
				if (mutation === "missing") result.events.splice(1, 1);
				if (mutation === "duplicate") result.events.push({ ...result.events[1]! });
				if (mutation === "other-tool") result.events[0]!.toolName = "shell";
				expect(evalCase.validate!(result).length, mutation).toBeGreaterThan(0);
			}
		});
		test(`${stage}: rejects verbose labels, history, and lost criteria`, () => {
			for (const patch of [{ subject: "x".repeat(81) }, { activeForm: "x".repeat(81) }, { description: "x".repeat(241) }, { description: "one\ntwo\nthree" }, { description: "TRACE-OLD-REVIEW: 73 specs, baseline.json" }, { description: "Tests passed." }]) {
				const result = fixture(stage);
				const input = result.events[0]!.input as { items: Record<string, unknown>[] };
				Object.assign(input.items[0]!, patch);
				expect(evalCase.validate!(result).length, JSON.stringify(patch)).toBeGreaterThan(0);
			}
		});
	}
	test("rejects a stale blocker and dropping criterion during an update", () => {
		const blocked = TODO_CONCISENESS_CASES.find((item) => item.id.endsWith("blocked"))!;
		const result = fixture("blocked");
		(result.events[2]!.input as Record<string, unknown>).description = "No duplicate charge; waiting for old desktop review.";
		expect(blocked.validate!(result).length).toBeGreaterThan(0);
		const verification = TODO_CONCISENESS_CASES.find((item) => item.id.endsWith("verification"))!;
		const updated = fixture("verification");
		(updated.events[2]!.input as Record<string, unknown>).description = "Focused tests passed.";
		expect(verification.validate!(updated).length).toBeGreaterThan(0);
	});
	test("rejects a missing checkpoint and incomplete finalization", () => {
		const completion = TODO_CONCISENESS_CASES.find((item) => item.id.endsWith("completion"))!;
		for (const index of [2, 4, 6]) {
			const result = fixture("completion");
			result.events.splice(index, 2);
			expect(completion.validate!(result).length).toBeGreaterThan(0);
		}
	});
	test("accepts terse descriptions without unnecessary repetition", () => {
		const result = fixture("create");
		const input = result.events[0]!.input as { items: Record<string, unknown>[] };
		input.items[0]!.subject = "Verify no duplicate charge after retry";
		delete input.items[0]!.description;
		expect(TODO_CONCISENESS_CASES[0]!.validate!(result)).toEqual([]);
	});
	test("rejects a no-op verification update and out-of-order results", () => {
		const evalCase = TODO_CONCISENESS_CASES.find((item) => item.id.endsWith("verification"))!;
		const noOp = fixture("verification");
		delete (noOp.events[2]!.input as Record<string, unknown>).description;
		expect(evalCase.validate!(noOp).length).toBeGreaterThan(0);
		const outOfOrder = fixture("verification");
		outOfOrder.events = [outOfOrder.events[0]!, outOfOrder.events[2]!, outOfOrder.events[1]!, outOfOrder.events[3]!];
		expect(evalCase.validate!(outOfOrder).length).toBeGreaterThan(0);
	});
});
