import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DECISION_POLICY_CASES, validateDecisionResult } from "./decision-policy.js";
import { deriveMetrics } from "./harness/metrics.js";
import { resolveEvalOutputDir } from "./harness/output-dir.js";
import type { EvalRunResult } from "./harness/types.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/decision-policy");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function result(action: string, recordPaths: string[] = [], changedFiles: string[] = []): EvalRunResult {
	const root = resolveEvalOutputDir("decision-policy-unit");
	fs.mkdirSync(root, { recursive: true });
	fs.cpSync(FIXTURE, root, { recursive: true });
	roots.push(root);
	return {
		caseId: "test", model: "test", projectDir: root,
		stdout: `DECISION_RESULT=${JSON.stringify({ action, recordPaths, reason: "Supplied evidence justifies this decision-history action." })}`,
		stderr: "", exitCode: 0, timedOut: false, events: [], assertions: [], passed: false,
		metrics: deriveMetrics({ events: [], elapsedMs: 0, changedFiles, projectDir: root, sessionDir: root }),
	};
}

function createRecord(run: EvalRunResult, file = "docs/decisions/0003-test-choice.md"): void {
	const template = fs.readFileSync(path.join(run.projectDir, "docs/decisions/TEMPLATE.md"), "utf8")
		.replace("proposed | accepted | superseded | withdrawn", "proposed")
		.replace("relative Markdown link", "[Product](../../specs/product.md)");
	fs.writeFileSync(path.join(run.projectDir, file), template);
	fs.appendFileSync(path.join(run.projectDir, "specs/product.md"), `\n[New decision](../${file})\n`);
}

describe("decision-record behavioral evals", () => {
	test("registers parent positive/negative controls and both auditor outcomes using current instructions", () => {
		expect(DECISION_POLICY_CASES).toHaveLength(8);
		expect(new Set(DECISION_POLICY_CASES.map((item) => item.id)).size).toBe(8);
		const parent = DECISION_POLICY_CASES.find((item) => item.id === "decision.bugfix-no-record")!;
		expect(parent.appendSystemPrompt).toContain("Default to no new decision record");
		expect(parent.appendSystemPrompt).toContain("six months");
		const auditor = DECISION_POLICY_CASES.find((item) => item.id === "decision.auditor-accepts-no-record")!;
		expect(auditor.appendSystemPrompt).toContain("A justified no-record handoff is valid");
		expect(auditor.appendSystemPrompt).not.toStartWith("---");
		for (const item of DECISION_POLICY_CASES) expect(item.prompt).not.toContain("expected decision action");
	});

	test("accepts no record, applicable link, and auditor escalation without file changes", () => {
		expect(validateDecisionResult(result("none"), "none")).toEqual([]);
		expect(validateDecisionResult(result("link", ["docs/decisions/0002-local-snapshots.md"]), "link")).toEqual([]);
		expect(validateDecisionResult(result("escalate"), "escalate")).toEqual([]);
	});

	test("accepts a real new record and reciprocal spec link", () => {
		const file = "docs/decisions/0003-test-choice.md";
		const run = result("create", [file], [file, "specs/product.md"]);
		createRecord(run);
		expect(validateDecisionResult(run, "create")).toEqual([]);
	});

	test("rejects narration without artifact and wrong action", () => {
		expect(validateDecisionResult(result("create", ["docs/decisions/0003-missing.md"]), "create").join(" ")).toContain("exactly one new decision");
		expect(validateDecisionResult(result("none"), "create").join(" ")).toContain("expected decision action create");
		expect(validateDecisionResult(result("escalate"), "none").join(" ")).toContain("expected decision action none");
	});

	test("rejects duplicate/unrequested records even when the answer claims no record", () => {
		const run = result("none");
		createRecord(run);
		expect(validateDecisionResult(run, "none").join(" ")).toContain("unexpected decision files");
	});

	test("rejects pruning or rewriting a historical record and editing the template", () => {
		for (const file of ["0001-legacy-label.md", "0002-local-snapshots.md", "TEMPLATE.md"]) {
			const run = result("none");
			fs.writeFileSync(path.join(run.projectDir, "docs/decisions", file), "rewritten");
			expect(validateDecisionResult(run, "none").join(" ")).toContain("historical record/template modified or removed");
		}
		const run = result("none");
		fs.rmSync(path.join(run.projectDir, "docs/decisions/0001-legacy-label.md"));
		expect(validateDecisionResult(run, "none").join(" ")).toContain("historical record/template modified or removed");
	});

	test("rejects wrong existing path, malformed JSON, and absent rationale", () => {
		expect(validateDecisionResult(result("link", ["docs/decisions/0001-legacy-label.md"]), "link").join(" ")).toContain("applicable existing snapshot");
		const run = result("none");
		run.stdout = "DECISION_RESULT=not-json";
		expect(validateDecisionResult(run, "none").join(" ")).toContain("malformed DECISION_RESULT");
		run.stdout = 'DECISION_RESULT={"action":"none","recordPaths":[],"reason":""}';
		expect(validateDecisionResult(run, "none").join(" ")).toContain("rationale must be supplied");
	});

	test("rejects missing template sections, absent reciprocal link, and unrelated mutations", () => {
		const file = "docs/decisions/0003-test-choice.md";
		const run = result("create", [file], [file, "src/product.ts"]);
		fs.writeFileSync(path.join(run.projectDir, file), "# Only a title");
		const failures = validateDecisionResult(run, "create").join(" ");
		expect(failures).toContain("missing Evidence section");
		expect(failures).toContain("missing decision status");
		expect(failures).toContain("missing governing spec link");
		expect(failures).toContain("link back");
		expect(failures).toContain("unexpected task mutation: src/product.ts");
	});
});
