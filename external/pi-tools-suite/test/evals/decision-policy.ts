import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_DISCOVERY_TOOLS } from "../../src/tool-descriptions.js";
import type { EvalCase, EvalRunResult } from "./harness/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "decision-policy");
const EXISTING_RECORD = "docs/decisions/0002-local-snapshots.md";
const BASELINE_DECISIONS = decisionFiles(FIXTURE);
const parentPolicy = ["repo_context", "repo_audit"].map((name) => {
	const tool = REPO_DISCOVERY_TOOLS.find((item) => item.name === name)!;
	return tool.promptGuidelines[2];
}).join("\n\n");
// Read the shipped role, not a frozen copy or an answer embedded in the user prompt.
const auditorPolicy = fs.readFileSync(path.join(HERE, "../../src/async-subagents/agents/knowledge-auditor.md"), "utf8")
	.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");

type DecisionAction = "none" | "create" | "link" | "escalate";
type Scenario = { id: string; description: string; prompt: string; expected: DecisionAction; auditor?: boolean };

const SCENARIOS: Scenario[] = [
	{
		id: "bugfix-no-record", description: "An ordinary verified bug fix does not automatically require an ADR.", expected: "none",
		prompt: "The retry bug fix is complete and its tests pass. It corrects a typo in an existing idempotency key comparison without changing the design, accepting new risk, or introducing a costly commitment. The product spec is current. Finish the decision-history handoff.",
	},
	{
		id: "ux-no-record", description: "An ordinary UX/spec change does not automatically require an ADR; historical records survive.", expected: "none",
		prompt: "The product owner approved changing a tooltip from Submit to Save. That one-string UX change and its current spec update are complete and verified. No product constraint or design trade-off changed. Finish the decision-history handoff and consider whether the old legacy-label record still belongs in the log under the current policy.",
	},
	{
		id: "model-no-record", description: "A reversible default-model substitution alone does not require an ADR.", expected: "none",
		prompt: "The default model configuration was changed to zai/glm-5-turbo and verified. This is a reversible identifier substitution with unchanged provider policy and behavior. No comparative benchmark, accepted risk, rejected design, or special commitment was discussed. Finish the decision-history handoff.",
	},
	{
		id: "costly-choice-record", description: "A costly storage choice with durable rationale is recorded with honest evidence and spec links.", expected: "create",
		prompt: "The telemetry storage choice has been implemented and verified. In this discussion the product owner selected append-only segments over a mutable row store for seven-year retention: repairability after partial writes matters more than query latency. Both were feasible; converting seven years of data later is costly. The owner explicitly accepted slower ad-hoc queries and expects future maintainers to be tempted to reverse the choice. These are owner-reported requirements, not measured benchmarks. No existing record covers telemetry. The current spec is specs/product.md. Finish the decision-history handoff, completing any required record now.",
	},
	{
		id: "existing-record-link", description: "Applicable accepted rationale is linked instead of duplicated.", expected: "link",
		prompt: "An offline snapshot persistence fix is complete. Local snapshots are retained instead of using a server-only design, for the same traveling-user/offline requirement and accepted freshness trade-off as the existing accepted decision. No scope or rationale changed and no replacement was approved. Finish the decision-history handoff.",
	},
	{
		id: "explicit-request-record", description: "An explicit user request records even a routine choice without fabricated alternatives.", expected: "create",
		prompt: "I explicitly want a new decision record for my approved tooltip rename from Submit to Save, although it is a routine UX edit. Record that I requested it in this conversation; I approved the rename, not any broader design. No alternatives or measurements were discussed. The change is complete and specs/product.md is current. Please write the record now and finish the handoff.",
	},
	{
		id: "auditor-accepts-no-record", description: "The shipped auditor accepts a justified no-record handoff for ordinary verified work.", expected: "none", auditor: true,
		prompt: "Parent handoff: an ordinary retry typo bug fix is complete and verified; exact task-changed path: specs/product.md (already current). No new decision record: this corrects existing behavior without a new trade-off, accepted risk, costly reversal, or durable design dispute. Triage the decision-record obligation only. Index maintenance is outside this bounded check; do not claim a full knowledge audit passed.",
	},
	{
		id: "auditor-escalates-missing-record", description: "The auditor escalates an undocumented qualifying choice rather than inventing rationale.", expected: "escalate", auditor: true,
		prompt: "Parent handoff: append-only telemetry segments were selected over a feasible mutable row store for seven-year retention, accepting slower ad-hoc queries for repairability after partial writes. Conversion later is costly and repeating the argument would waste future effort. The product owner reported and approved these priorities. Exact task-changed path: specs/product.md (already current). The parent supplied no decision record for this new choice and none exists. Triage the decision-record obligation only. Index maintenance is outside this bounded check; do not claim a full knowledge audit passed.",
	},
];

export const DECISION_POLICY_CASES: EvalCase[] = SCENARIOS.map((scenario) => ({
	id: `decision.${scenario.id}`,
	category: scenario.auditor ? "orchestration" : "coding-quality",
	description: scenario.description,
	fixture: "decision-policy",
	appendSystemPrompt: scenario.auditor ? auditorPolicy : parentPolicy,
	prompt: `${scenario.prompt}\n\nRead the existing docs/decisions records, their TEMPLATE.md, and specs/product.md before deciding. This is only a bounded decision-history completion/triage, not a coding task or full index audit. Do not delegate. ${scenario.auditor ? "Return your triage without changing any files." : "Carry out the applicable decision-history action, not just a proposal."}\nFinish with a single plain line DECISION_RESULT={"action":"none|create|link|escalate","recordPaths":[],"reason":"your rationale"}. Use exactly one action value and project-relative paths for any created or applicable existing record.`,
	assert: { forbiddenTools: ["subagents", "async_subagents_spawn"], maxToolCalls: 20 },
	validate: (result) => validateDecisionResult(result, scenario.expected),
}));

/** Machine-check both the declared choice and the actual files; narration alone cannot pass. */
export function validateDecisionResult(result: EvalRunResult, expected: DecisionAction): string[] {
	const failures: string[] = [];
	const lines = [...result.stdout.matchAll(/DECISION_RESULT=(\{[^\r\n]*\})/g)];
	let report: Record<string, unknown> = {};
	try { report = JSON.parse(lines[lines.length - 1]?.[1] ?? ""); }
	catch { failures.push("missing or malformed DECISION_RESULT JSON"); }
	if (!report || typeof report !== "object" || Array.isArray(report)) report = {};
	if (report.action !== expected) failures.push(`expected decision action ${expected}, got ${String(report.action)}`);
	if (typeof report.reason !== "string" || report.reason.trim().length < 20) failures.push("decision rationale must be supplied");
	const paths = Array.isArray(report.recordPaths) && report.recordPaths.every((item) => typeof item === "string") ? report.recordPaths as string[] : [];
	if (!Array.isArray(report.recordPaths) || paths.length !== report.recordPaths.length) failures.push("recordPaths must be a string array");
	const after = decisionFiles(result.projectDir);
	for (const [file, content] of BASELINE_DECISIONS) {
		if (after.get(file) !== content) failures.push(`historical record/template modified or removed: ${file}`);
	}
	const created = [...after.keys()].filter((file) => !BASELINE_DECISIONS.has(file));
	if (expected !== "create" && created.length) failures.push(`unexpected decision files: ${created.join(", ")}`);
	if (expected === "none" || expected === "escalate") {
		if (paths.length) failures.push("no-record/escalation must not claim decision paths");
	}
	if (expected === "link" && (paths.length !== 1 || paths[0] !== EXISTING_RECORD)) failures.push("must link the applicable existing snapshot decision");
	if (expected === "create") {
		if (created.length !== 1 || paths.length !== 1 || paths[0] !== created[0]) failures.push("must create and report exactly one new decision file");
		for (const file of created) {
			if (!/^docs\/decisions\/\d{4}-[^/]+\.md$/.test(file)) failures.push(`invalid decision filename: ${file}`);
			const content = after.get(file)!;
			for (const heading of ["Context", "Evidence", "Decision", "Alternatives", "Consequences", "Revisit"]) {
				if (!new RegExp(`^## .*${heading}`, "im").test(content)) failures.push(`${file} missing ${heading} section`);
			}
			if (!/Status:\s*(proposed|accepted)/i.test(content)) failures.push(`${file} missing decision status`);
			if (!content.includes("../../specs/product.md")) failures.push(`${file} missing governing spec link`);
			const specPath = path.join(result.projectDir, "specs/product.md");
			const spec = fs.existsSync(specPath) ? fs.readFileSync(specPath, "utf8") : "";
			if (!spec.includes(`../${file}`)) failures.push("governing spec must link back to the new decision");
		}
	}
	const allowed = expected === "create" ? new Set([...created, "specs/product.md"]) : new Set<string>();
	for (const file of result.metrics.changedFiles) if (!allowed.has(file)) failures.push(`unexpected task mutation: ${file}`);
	return failures;
}

function decisionFiles(root: string): Map<string, string> {
	const files = new Map<string, string>();
	const directory = path.join(root, "docs/decisions");
	if (!fs.existsSync(directory)) return files;
	for (const entry of fs.readdirSync(directory, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile()) continue;
		const absolute = path.join(entry.parentPath, entry.name);
		files.set(path.relative(root, absolute).split(path.sep).join("/"), fs.readFileSync(absolute, "utf8"));
	}
	return files;
}
