import type { EvalCase, EvalRunResult } from "./harness/types.js";

export const SESSION_EVAL_CASES: EvalCase[] = [
	sessionCase(
		"tool.session-recovery-overview",
		"Lost context without a search phrase should begin with session action=overview.",
		"My working context was aggressively compressed and I no longer remember the task. I have no reliable phrase to search for. Use the appropriate raw-session recovery tool first and stop immediately after that first tool call.",
		["overview"],
	),
	sessionCase(
		"tool.session-name-set",
		"An explicit session rename should use action=name with the requested title.",
		"Rename this conversation to Checkout retry audit. Do not inspect files or change anything else. Stop immediately after renaming it.",
		["name"],
		(input) => input.name === "Checkout retry audit",
	),
	sessionCase(
		"tool.session-name-read",
		"Reading the current title should use action=name without a replacement name.",
		"What is this conversation's current title? Read the stored title without renaming it or examining its history. Stop immediately after reading it.",
		["name"],
		(input) => input.name === undefined,
	),
	sessionCase(
		"tool.session-recovery-read",
		"A mapped raw-session entry should be read using its returned section or entry ID.",
		"First map this conversation's raw history, then read the exact raw entry or section containing this user request, using an ID from the map. Do not search files. Stop after that history read.",
		["overview", "read"],
		(input) => input.cursor === undefined && [input.entry_id, input.section_id]
			.filter((id) => typeof id === "string" && id.trim().length > 0).length === 1,
	),
	sessionCase(
		"tool.session-recovery-search",
		"A known literal should select lexical raw-session search without an overview preflight.",
		"Find the literal SESSION-SEARCH-ANCHOR in this conversation's raw history, not in repository files. I already know the exact phrase, so do not map the history first. Stop immediately after the history search.",
		["search"],
		(input) => typeof input.query === "string" && input.query.toLowerCase() === "session-search-anchor",
	),
	sessionCase(
		"tool.session-recovery-signals",
		"Deterministic recovery signals should follow an overview and bound recent historical errors.",
		"First map this conversation's raw history. Then get its deterministic recovery signals: original/latest instructions, read/modified files, and at most three recent tool errors. Do not assume historical errors are unresolved. Stop after fetching those signals.",
		["overview", "recovery"],
		(input) => input.recent_error_limit === 3,
	),
];

function sessionCase(
	id: string,
	description: string,
	prompt: string,
	actions: string[],
	checkLastInput?: (input: Record<string, unknown>) => boolean,
): EvalCase {
	return {
		id, description, prompt,
		category: "tool-selection",
		fixture: "demo",
		assert: { firstTool: "session", maxToolCalls: actions.length },
		validate: (result) => validateSessionCalls(result, actions, checkLastInput),
	};
}

function validateSessionCalls(
	result: EvalRunResult,
	actions: string[],
	checkLastInput?: (input: Record<string, unknown>) => boolean,
): string[] {
	const calls = result.events.filter((event) => event.type === "tool_call");
	if (calls.length !== actions.length || calls.some((call, index) => call.toolName !== "session" || asRecord(call.input)?.action !== actions[index])) {
		return [`Expected only session actions in order: ${actions.join(" → ")}.`];
	}
	const lastInput = asRecord(calls[calls.length - 1]?.input);
	if (checkLastInput && (!lastInput || !checkLastInput(lastInput))) return ["Session action arguments do not match the request."];
	for (const [index, call] of calls.entries()) {
		const results = result.events.filter((event) => event.type === "tool_result" && event.toolName === "session" && event.toolCallId === call.toolCallId);
		if (!call.toolCallId || results.length !== 1 || results[0]!.isError !== false) return ["Every session call must have one successful recorded result."];
		const resultIndex = result.events.indexOf(results[0]!);
		const nextCall = calls[index + 1];
		if (resultIndex <= result.events.indexOf(call) || (nextCall && resultIndex >= result.events.indexOf(nextCall))) {
			return ["Each session result must arrive before the next action is called."];
		}
	}
	return [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
