import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildProjectPlanPrompt } from "../../../../desktop/src/app/project-plan-prompt.js";
import { EVAL_CASES } from "./cases.js";
import { resolveEvalOutputDir } from "./harness/output-dir.js";
import { PLAN_FIXTURE, PLAN_GUIDANCE_CASES, PLAN_SCENARIOS, validatePlanCheckpoint } from "./plan-guidance.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function result(id: string, overrides: Record<string, unknown> = {}): Parameters<typeof validatePlanCheckpoint>[0] {
	const root = resolveEvalOutputDir("plan-guidance-validator");
	fs.mkdirSync(root, { recursive: true });
	fs.cpSync(PLAN_FIXTURE, root, { recursive: true });
	roots.push(root);
	const expected = PLAN_SCENARIOS.find((scenario) => scenario.id === id)!.expected;
	return {
		projectDir: root,
		stdout: "PLAN_RESULT=" + JSON.stringify({ ...expected, ...overrides }),
		events: [
			{ type: "tool_call", toolName: "read", toolCallId: "plan-read", input: { path: "plans/" + id + ".md" } },
			{ type: "tool_result", toolName: "read", toolCallId: "plan-read", isError: false },
		],
		metrics: { changedFiles: [] },
	};
}

describe("plan guidance behavioral evals", () => {
	test("registers six checkpoints using the current guide and production Run prompt", () => {
		expect(PLAN_GUIDANCE_CASES).toHaveLength(6);
		expect(new Set(PLAN_GUIDANCE_CASES.map((item) => item.id)).size).toBe(6);
		const guide = fs.readFileSync(new URL("../../docs/plan-writing.md", import.meta.url), "utf8");
		for (const scenario of PLAN_SCENARIOS) {
			const item = PLAN_GUIDANCE_CASES.find((entry) => entry.id === "plan." + scenario.id)!;
			expect(EVAL_CASES).toContain(item);
			expect(item.fixture).toBe("plan-guidance");
			if (scenario.authoring) expect(item.appendSystemPrompt).toBe(guide);
			else {
				expect(item.appendSystemPrompt).toBeUndefined();
				expect(item.prompt).toStartWith(buildProjectPlanPrompt("plans/" + scenario.id + ".md"));
			}
			expect(item.blockTools).toEqual(["subagents", "async_subagents_spawn"]);
			expect(item.assert.maxFilesChanged).toBe(0);
		}
	});

	test.each(PLAN_SCENARIOS)("accepts the observed $id checkpoint", ({ id }) => {
		expect(validatePlanCheckpoint(result(id), id)).toEqual([]);
	});

	test("accepts reordered sets and absolute plan reads", () => {
		const run = result("independent", {
			readySteps: ["B", "A"], parallelGroups: [["B", "A"]], nextActions: { B: "implement", A: "implement" },
		});
		run.events[0]!.input = { file_path: path.join(run.projectDir, "plans/independent.md") };
		run.events[0]!.toolName = "Read";
		expect(validatePlanCheckpoint(run, "independent")).toEqual([]);
	});

	test.each([
		{ id: "shared-contract", change: { readySteps: ["A", "B"], parallelGroups: [["A", "B"]] }, failure: "parallelGroups" },
		{ id: "shared-contract", change: { needsUserInput: true }, failure: "needsUserInput" },
		{ id: "scoped-blocker", change: { readySteps: [], blockedSteps: ["A", "B", "I"] }, failure: "readySteps" },
		{ id: "scoped-blocker", change: { needsUserInput: false }, failure: "needsUserInput" },
		{ id: "failed-gate", change: { gateDecisions: { migration: "Go" }, readySteps: ["M"] }, failure: "gateDecisions" },
		{ id: "worker-claim", change: { completedSteps: ["A", "B"], gateDecisions: { integration: "Go" } }, failure: "completedSteps" },
		{ id: "worker-claim", change: { nextActions: { A: "integrate" } }, failure: "nextActions" },
		{ id: "invalidated-evidence", change: { reopenSteps: [], completedSteps: ["A", "B"] }, failure: "reopenSteps" },
		{ id: "invalidated-evidence", change: { gateDecisions: { integration: "Go" } }, failure: "gateDecisions" },
		{ id: "invalidated-evidence", change: { reuseEvidence: ["adapter-v1", "view-v2"] }, failure: "reuseEvidence" },
		{ id: "invalidated-evidence", change: { historicalEvidence: [] }, failure: "historicalEvidence" },
		{ id: "invalidated-evidence", change: { reopenSteps: ["A", "B"], completedSteps: [] }, failure: "completedSteps" },
		{ id: "independent", change: { parallelGroups: [], integrator: "workers" }, failure: "integrator" },
	])("rejects an incorrect $id decision ($failure)", ({ id, change, failure }) => {
		expect(validatePlanCheckpoint(result(id, change), id).join(" ")).toContain(failure);
	});

	test.each([
		{ readySteps: ["A", "A", "B"] }, { blockedSteps: "I" }, { completedSteps: [1] },
		{ parallelGroups: [["A", "B"], ["A", "B"]] }, { parallelGroups: [["A"]] },
		{ gateDecisions: [] }, { nextActions: { A: true, B: "implement" } }, { needsUserInput: "false" },
	])("rejects malformed fields: %j", (change) => {
		expect(validatePlanCheckpoint(result("independent", change), "independent").length).toBeGreaterThan(0);
	});

	test("rejects missing, malformed, duplicate and non-object reports", () => {
		const run = result("independent");
		const valid = run.stdout;
		for (const stdout of ["Done", "PLAN_RESULT=not-json", valid + "\n" + valid, valid + "\nPLAN_RESULT=not-json", "PLAN_RESULT=[]", "PLAN_RESULT=null"]) {
			run.stdout = stdout;
			expect(validatePlanCheckpoint(run, "independent").length).toBeGreaterThan(0);
		}
		expect(validatePlanCheckpoint(run, "missing")).toEqual(["unknown plan scenario: missing"]);
	});

	test("requires a matching successful read of the named plan", () => {
		for (const mode of ["absent", "failed", "wrong-plan", "wrong-call", "result-before-call"]) {
			const run = result("independent");
			if (mode === "absent") run.events = [];
			if (mode === "failed") run.events[1]!.isError = true;
			if (mode === "wrong-plan") run.events[0]!.input = { path: "plans/shared-contract.md" };
			if (mode === "wrong-call") run.events[1]!.toolCallId = "other";
			if (mode === "result-before-call") run.events.reverse();
			expect(validatePlanCheckpoint(run, "independent").join(" ")).toContain("successfully read");
		}
	});

	test("rejects changed or missing plans even if metrics claim no file changes", () => {
		for (const remove of [false, true]) {
			const run = result("independent");
			const plan = path.join(run.projectDir, "plans/independent.md");
			if (remove) fs.rmSync(plan);
			else fs.appendFileSync(plan, "\n- [x] Unverified completion\n");
			expect(validatePlanCheckpoint(run, "independent").join(" ")).toContain("changed or removed its saved plan");
		}
	});

	test("rejects unrelated file changes", () => {
		const run = result("independent");
		run.metrics.changedFiles = ["src/unrelated.ts"];
		expect(validatePlanCheckpoint(run, "independent").join(" ")).toContain("unrelated file changes");
	});
});
