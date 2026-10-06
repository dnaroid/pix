import type { EvalCase, EvalRunResult } from "./harness/types.js";

export type TodoStage = "create" | "verification" | "blocked" | "completion";

const HANDOFF = `This is a plan-maintenance exercise using supplied facts, not a request to execute tests or edit files.
Create a tracked two-item plan: verify the checkout retry fix, then give the final user-facing report. Mark only verification in progress. The verification acceptance criterion is no duplicate charge after retry; preserve that criterion in the plan.
The supplied handoff contains background evidence, not additional tasks: focused tests passed (18/18), full tests passed (205/205), typecheck exit 0, diff-check exit 0. Logs: .pi/artifacts/checkout-run/focused.log, .pi/artifacts/checkout-run/full.log, .pi/artifacts/checkout-run/types.log. Historical baseline: 73 specs, 37 clean, 36 dirty, 0 errors. Earlier partial review covered six specs; native audit report saved in .pi/artifacts/checkout-run/baseline.json. TRACE-OLD-REVIEW: a prior desktop review was revoked and is not a current blocker. Do not treat that background as verification you performed yourself.`;

const REQUESTS: Record<TodoStage, string> = {
	create: "Stop after creating the plan; do not apply the supplied test results yet.",
	verification: "After creation, apply the supplied successful test results to the verification item with a todo update noting that tests passed, leaving it in progress for final sign-off. Stop after that update.",
	blocked: "After creation, the current checkpoint is waiting for user approval of the checkout result. Update verification to deferred and record that external blocker. Leave the report pending. Stop; do not ask for approval in this exercise.",
	completion: "After creation, apply the supplied test results in an update noting that tests passed while verification is still in progress. Then approval has been granted: complete verification, activate the report, give a brief report, and complete the report item. Stop with no unfinished tasks.",
};

export const TODO_CONCISENESS_CASES: EvalCase[] = (Object.keys(REQUESTS) as TodoStage[]).map((stage) => ({
	id: `tool.todo-concise-${stage}`,
	category: "tool-selection",
	description: `Todo ${stage} keeps short task text without losing acceptance criteria or current blockers.`,
	fixture: "demo",
	prompt: `${HANDOFF}\n${REQUESTS[stage]}`,
	assert: { requiredTools: ["todo"], maxToolCalls: 10, maxFilesChanged: 0 },
	validate: (result) => validateTodoConciseness(result, stage),
}));

// These are eval tolerances, not runtime length limits. Inspect every mutation,
// including descriptions that might later be overwritten or auto-cleared.
export function validateTodoConciseness(result: EvalRunResult, stage: TodoStage): string[] {
	const scores = scoreTodoConciseness(result, stage);
	return [...scores.brevityErrors, ...scores.lifecycleErrors];
}

export function scoreTodoConciseness(result: EvalRunResult, stage: TodoStage): { brevityErrors: string[]; lifecycleErrors: string[] } {
	return { brevityErrors: validateTodoText(result), lifecycleErrors: validateTodoLifecycle(result, stage) };
}

function validateTodoText(result: EvalRunResult): string[] {
	const errors: string[] = [];
	for (const call of result.events.filter((event) => event.type === "tool_call" && event.toolName === "todo")) {
		const input = record(call.input);
		if (!["create", "update", "batch_create", "batch_update"].includes(String(input.action))) continue;
		const items = String(input.action).startsWith("batch_") ? input.items : [input];
		if (!Array.isArray(items)) continue;
		for (const value of items) {
			const item = record(value);
			for (const [field, limit] of [["subject", 80], ["activeForm", 80], ["description", 240]] as const) {
				const text = item[field];
				if (text === undefined) continue;
				if (typeof text !== "string" || [...text].length > limit || text.split(/\r?\n/).length > 2) errors.push(`${field} exceeds brief-text tolerance (${limit} characters, 2 lines).`);
				if (typeof text === "string" && /TRACE-OLD-REVIEW|73 specs|37 clean|36 dirty|baseline\.json|focused\.log|full\.log|types\.log/i.test(text)) errors.push(`${field} copied background history or a log inventory.`);
			}
		}
	}
	return errors;
}

function hasSuccessfulTestCheckpoint(text: string): boolean {
	if (!/tests?\b/i.test(text)) return false;
	if (/\b(?:failed|failing|pending|unverified)\b|\b(?:not|never|didn't|haven't|hasn't|aren't)\s+(?:yet\s+)?(?:pass(?:ed|ing)?|run|executed|green|successful|succeeded)\b|\b(?:will|would|should|may)\s+pass\b|\bexit\s+[1-9]\d*\b/i.test(text)) return false;
	const ratios = [...text.matchAll(/\b(\d+)\s*\/\s*(\d+)\b/g)];
	if (ratios.some((match) => Number(match[1]) === 0 || Number(match[1]) !== Number(match[2]))) return false;
	if (/\b[1-9]\d*\s+(?:failures?|errors?)\b/i.test(text)) return false;
	return /\bpass(?:ed|ing)?\b|\b(?:successful|succeeded|green)\b/i.test(text) || ratios.length > 0;
}

function validateTodoLifecycle(result: EvalRunResult, stage: TodoStage): string[] {
	const errors: string[] = [];
	const tasks = new Map<number, Record<string, unknown>>();
	let nextId = 1;
	let created = 0;
	let verified = false;
	let blocked = false;
	let reportActivated = false;
	const calls = result.events.filter((event) => event.type === "tool_call");
	for (const call of calls) {
		if (call.toolName !== "todo") { errors.push("Only todo calls are allowed in the supplied-facts exercise."); continue; }
		const replies = result.events.filter((event) => event.type === "tool_result" && event.toolCallId === call.toolCallId && event.toolName === "todo");
		if (!call.toolCallId || replies.length !== 1 || replies[0]!.isError !== false || result.events.indexOf(replies[0]!) <= result.events.indexOf(call)) {
			errors.push("Each todo call needs one successful matching result.");
		}
		const nextCall = calls[calls.indexOf(call) + 1];
		if (nextCall && replies.length === 1 && result.events.indexOf(replies[0]!) >= result.events.indexOf(nextCall)) errors.push("Wait for each todo result before the next checkpoint.");
		const input = record(call.input);
		const action = input.action;
		const create = action === "create" || action === "batch_create";
		const update = action === "update" || action === "batch_update";
		if (!create && !update) {
			if (action !== "list" && action !== "get") errors.push("No clearing, deleting, importing or exporting the plan.");
			continue;
		}
		const items = action === "batch_create" || action === "batch_update" ? input.items : [input];
		if (!Array.isArray(items) || (input.replace === true && (action !== "batch_create" || tasks.size > 0))) { errors.push("Expected ordinary items; do not replace an existing plan."); continue; }
		for (const value of items) {
			const item = record(value);
			if (create) {
				if (typeof item.subject !== "string" || !item.subject.trim()) errors.push("Created tasks need action labels.");
				tasks.set(nextId++, { ...item, status: item.status ?? "pending" });
				created++;
				if (nextId === 2 && item.status !== "in_progress") errors.push("Verification must start in progress.");
				if (nextId === 3 && (item.status ?? "pending") !== "pending") errors.push("Report must start pending.");
			} else {
				const previous = tasks.get(Number(item.id));
				if (!previous) { errors.push("Update targets an unknown task."); continue; }
				const task = { ...previous, ...item };
				tasks.set(Number(item.id), task);
				if (item.id === 1 && task.status === "in_progress" && hasSuccessfulTestCheckpoint(`${item.description ?? ""} ${item.activeForm ?? ""}`)) verified = true;
				if (item.id === 1 && task.status === "completed" && !verified) errors.push("Verification completed before the test checkpoint.");
				if (item.id === 1 && task.status === "deferred" && /(?:user.*approv|approv.*user)/i.test(String(task.description ?? ""))) blocked = true;
				if (item.id === 2 && task.status === "in_progress") {
					if (!verified || tasks.get(1)?.status !== "completed") errors.push("Report activated before verification completed.");
					reportActivated = true;
				}
				if (item.id === 2 && task.status === "completed" && !reportActivated) errors.push("Report completed before activation.");
			}
			const criterion = tasks.get(1);
			if (criterion && !/\b(?:no\s+duplicate\s+charges?|(?:does|do|must|will|should)\s+not\s+(?:cause|create|produce)\s+(?:a\s+)?duplicate\s+charges?|(?:prevent|avoid)\s+(?:a\s+)?duplicate\s+charges?)\b/i.test(`${criterion.subject} ${criterion.description ?? ""}`)) errors.push("Verification acceptance criterion was lost.");
		}
		if ([...tasks.values()].filter((task) => task.status === "in_progress").length > 1) errors.push("More than one task is active.");
	}
	if (created !== 2) errors.push("Expected exactly verification and final report tasks.");
	if (!/report/i.test(String(tasks.get(2)?.subject ?? ""))) errors.push("Second task must be the final report.");
	if (stage === "create" && (calls.some((call) => /update/.test(String(record(call.input).action))) || tasks.get(1)?.status !== "in_progress" || tasks.get(2)?.status !== "pending")) errors.push("Creation must stop with verification active and report pending.");
	if (stage === "verification" && (!verified || tasks.get(1)?.status !== "in_progress" || tasks.get(2)?.status !== "pending")) errors.push("Expected a verification update, leaving sign-off in progress.");
	if (stage === "blocked" && (!blocked || tasks.get(1)?.status !== "deferred" || tasks.get(2)?.status !== "pending")) errors.push("Expected deferred verification with the current user-approval blocker.");
	if (stage === "completion" && (!verified || !reportActivated || [...tasks.values()].some((task) => task.status !== "completed"))) errors.push("Expected verification update, report activation, and completion of both tasks.");
	return errors;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
