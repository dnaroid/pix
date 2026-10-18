import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProjectPlanPrompt } from "../../../../desktop/src/app/project-plan-prompt.js";
import type { EvalCase, EvalRunResult } from "./harness/types.js";

export const PLAN_FIXTURE = fileURLToPath(new URL("./fixtures/plan-guidance/", import.meta.url));
const guide = fs.readFileSync(new URL("../../docs/plan-writing.md", import.meta.url), "utf8");

export type PlanCheckpoint = {
	readySteps: string[];
	parallelGroups: string[][];
	blockedSteps: string[];
	completedSteps: string[];
	reopenSteps: string[];
	gateDecisions: Record<string, "Go" | "No-Go">;
	nextActions: Record<string, "implement" | "investigate" | "verify" | "integrate">;
	needsUserInput: boolean;
	integrator: "parent";
	reuseEvidence: string[];
	historicalEvidence: string[];
};

const checkpoint = (overrides: Partial<PlanCheckpoint>): PlanCheckpoint => ({
	readySteps: [], parallelGroups: [], blockedSteps: [], completedSteps: [], reopenSteps: [],
	gateDecisions: {}, nextActions: {}, needsUserInput: false, integrator: "parent",
	reuseEvidence: [], historicalEvidence: [], ...overrides,
});

export const PLAN_SCENARIOS = [
	{
		id: "independent", authoring: true,
		description: "An authorized beneficial split preserves exclusive ownership and a dependent integration step.",
		expected: checkpoint({ readySteps: ["A", "B"], parallelGroups: [["A", "B"]], blockedSteps: ["I"],
			nextActions: { A: "implement", B: "implement" }, reuseEvidence: ["contract-v1"] }),
	},
	{
		id: "shared-contract", authoring: true,
		description: "Different files do not justify parallel implementation before resolving a shared contract.",
		expected: checkpoint({ readySteps: ["C"], blockedSteps: ["A", "B", "I"], nextActions: { C: "investigate" } }),
	},
	{
		id: "scoped-blocker", authoring: false,
		description: "A product blocker pauses its branch while proven independent work remains ready.",
		expected: checkpoint({ readySteps: ["B"], blockedSteps: ["A", "I"], nextActions: { B: "implement" }, needsUserInput: true }),
	},
	{
		id: "failed-gate", authoring: false,
		description: "A failed readiness check prevents the protected action and leaves investigation available.",
		expected: checkpoint({ readySteps: ["F"], blockedSteps: ["M"], gateDecisions: { migration: "No-Go" },
			nextActions: { F: "investigate" } }),
	},
	{
		id: "worker-claim", authoring: false,
		description: "A worker's done message does not complete an unverified step or unlock integration.",
		expected: checkpoint({ readySteps: ["A"], blockedSteps: ["I"], completedSteps: ["B"],
			gateDecisions: { integration: "No-Go" }, nextActions: { A: "verify" }, reuseEvidence: ["view-v2"] }),
	},
	{
		id: "invalidated-evidence", authoring: false,
		description: "Integration invalidation reopens the affected flat-checklist item and its gate, preserving valid evidence.",
		expected: checkpoint({ readySteps: ["A"], blockedSteps: ["I"], completedSteps: ["B"], reopenSteps: ["A"],
			gateDecisions: { integration: "No-Go" }, nextActions: { A: "verify" },
			reuseEvidence: ["view-v2"], historicalEvidence: ["adapter-v1"] }),
	},
] satisfies Array<{ id: string; authoring: boolean; description: string; expected: PlanCheckpoint }>;

const reportContract = [
	"This request is a read-only scheduling checkpoint: stop before implementation, file changes or worker dispatch.",
	"Read the named saved plan. Its current-state snapshot supplies the facts needed for this checkpoint; no implementation sources or real workers are needed.",
	"Report the next ready work and current completion/verification state. Gate decisions describe the current evidence before future checks.",
	"Ready steps may start their next action now, including investigation or verification; blocked steps are unfinished work waiting on a blocker, dependency or gate.",
	"Completed steps currently satisfy their done conditions; exclude steps that must be reopened. Parallel groups describe beneficial permitted concurrent work among ready steps.",
	"Return one plain line PLAN_RESULT=<JSON object> with these fields:",
	"readySteps, blockedSteps, completedSteps, reopenSteps: arrays of step IDs; parallelGroups: arrays of simultaneous step-ID groups;",
	"gateDecisions: gate-name to Go or No-Go; nextActions: ready step-ID to implement, investigate, verify or integrate;",
	"needsUserInput: boolean; integrator: parent; reuseEvidence and historicalEvidence: evidence-ID arrays.",
	"Use empty arrays/objects when applicable. Historical evidence means retained records invalidated by later changes.",
].join("\n");

export const PLAN_GUIDANCE_CASES: EvalCase[] = PLAN_SCENARIOS.map((scenario) => {
	const planPath = "plans/" + scenario.id + ".md";
	return {
		id: "plan." + scenario.id, category: "orchestration", description: scenario.description,
		fixture: "plan-guidance",
		appendSystemPrompt: scenario.authoring ? guide : undefined,
		prompt: (scenario.authoring
			? "Review the saved plan at " + JSON.stringify(planPath) + " using the current authoring guidance."
			: buildProjectPlanPrompt(planPath)) + "\n\n" + reportContract,
		blockTools: ["subagents", "async_subagents_spawn"],
		assert: { forbiddenTools: ["subagents", "async_subagents_spawn"], maxToolCalls: 12, maxFilesChanged: 0 },
		validate: (result) => validatePlanCheckpoint(result, scenario.id),
	};
});

type CheckpointResult = Pick<EvalRunResult, "stdout" | "projectDir" | "events">
	& { metrics: Pick<EvalRunResult["metrics"], "changedFiles"> };

export function validatePlanCheckpoint(result: CheckpointResult, scenarioId: string): string[] {
	const scenario = PLAN_SCENARIOS.find((item) => item.id === scenarioId);
	if (!scenario) return ["unknown plan scenario: " + scenarioId];
	const failures: string[] = [];
	const matches = [...result.stdout.matchAll(/^PLAN_RESULT=(.*)$/gm)];
	let report: unknown;
	try {
		if (matches.length !== 1) throw new Error("expected one result");
		report = JSON.parse(matches[0]![1]!);
	} catch { return ["missing, duplicate or malformed PLAN_RESULT JSON"]; }
	if (!isRecord(report)) return ["PLAN_RESULT must be an object"];

	const expected = scenario.expected;
	for (const field of ["readySteps", "blockedSteps", "completedSteps", "reopenSteps", "reuseEvidence", "historicalEvidence"] as const) {
		if (stringSet(report[field]) !== stringSet(expected[field])) failures.push(field + " does not match the observed checkpoint");
	}
	if (parallelGroups(report.parallelGroups) !== parallelGroups(expected.parallelGroups)) failures.push("parallelGroups do not respect independence and dependencies");
	for (const field of ["gateDecisions", "nextActions"] as const) {
		if (stringMap(report[field]) !== stringMap(expected[field])) failures.push(field + " does not match the observed checkpoint");
	}
	if (report.needsUserInput !== expected.needsUserInput) failures.push("needsUserInput must distinguish technical discovery from a missing user decision");
	if (report.integrator !== "parent") failures.push("one parent integrator must own the combined result and plan");

	const planPath = path.resolve(result.projectDir, "plans", scenarioId + ".md");
	const readObserved = result.events.some((event, index) => {
		if (event.type !== "tool_call" || !["read", "Read"].includes(event.toolName ?? "") || !event.toolCallId || !isRecord(event.input)) return false;
		const inputPath = event.input.path ?? event.input.file_path;
		return typeof inputPath === "string" && path.resolve(result.projectDir, inputPath) === planPath
			&& result.events.slice(index + 1).some((next) => next.type === "tool_result"
				&& next.toolCallId === event.toolCallId && next.isError === false);
	});
	if (!readObserved) failures.push("the saved plan must be successfully read before reporting");
	if (!fs.existsSync(planPath) || fs.readFileSync(planPath, "utf8") !== fs.readFileSync(path.join(PLAN_FIXTURE, "plans", scenarioId + ".md"), "utf8")) {
		failures.push("the read-only checkpoint changed or removed its saved plan");
	}
	if (result.metrics.changedFiles.length) failures.push("the checkpoint made unrelated file changes");
	return failures;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringSet(value: unknown): string | null {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string") || new Set(value).size !== value.length) return null;
	return JSON.stringify([...value].sort());
}

function parallelGroups(value: unknown): string | null {
	if (!Array.isArray(value)) return null;
	const groups = value.map((group) => Array.isArray(group) && group.length >= 2 ? stringSet(group) : null);
	if (groups.some((group) => group === null)) return null;
	const members = value.flat();
	if (new Set(members).size !== members.length) return null;
	return JSON.stringify(groups.sort());
}

function stringMap(value: unknown): string | null {
	if (!isRecord(value) || !Object.values(value).every((item) => typeof item === "string")) return null;
	return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
