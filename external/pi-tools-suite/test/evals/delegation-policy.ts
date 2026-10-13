import { SUBAGENT_DELEGATION_GUIDANCE } from "../../src/async-subagents/core/agent-strategy.js";
import type { EvalCase, EvalRunResult } from "./harness/types.js";

/** Selection only: block spawning so these cases never pay for real workers. */
export function validateDelegationRole(result: EvalRunResult, role: string): string[] {
	const calls = result.events.filter((event) => event.type === "tool_call" && event.toolName === "subagents");
	if (calls.length !== 1) return ["expected exactly one subagents call"];
	const input = calls[0]?.input as { action?: string; tasks?: Array<{ subagentType?: string }> } | undefined;
	return input?.action === "spawn" && Array.isArray(input.tasks) && input.tasks.length === 1 && input.tasks[0]?.subagentType === role
		? [] : [`expected one explicit ${role} spawn`];
}

/** No user time cap in this scenario: keep the configured oracle watchdog. */
export function validateOracleBudget(result: EvalRunResult): string[] {
	const errors = validateDelegationRole(result, "oracle");
	if (errors.length) return errors;
	const call = result.events.find((event) => event.type === "tool_call" && event.toolName === "subagents");
	const input = call?.input as { timeoutSeconds?: unknown; tasks: Array<{ timeoutSeconds?: unknown }> };
	if (input.timeoutSeconds !== undefined || input.tasks[0]?.timeoutSeconds !== undefined) {
		return ["expected oracle to retain the configured watchdog without spawn/task timeoutSeconds"];
	}
	return [];
}

const delegationPolicyCases: EvalCase[] = [
	{
		id: "orchestration.size-alone-stays-parent",
		category: "orchestration",
		description: "Size and parallelizable work do not themselves justify a coding handoff.",
		fixture: "demo",
		prompt: "We will need a large multi-file checkout change with many parallelizable modules. The behavior and acceptance criteria are already settled and within your capabilities. Before touching files, briefly state who should write the implementation and why, then stop. No code or investigation yet.",
		assert: { forbiddenTools: ["subagents", "async_subagents_spawn"], maxFilesChanged: 0 },
	},
	{
		id: "orchestration.keeps-tiny-edit",
		category: "orchestration",
		description: "A few exact replacements stay in the parent rather than spawning mechanical.",
		fixture: "demo",
		prompt: "In docs/lsp-diagnostics.md replace the exact phrase `no diagnostics` with `clean diagnostics`. This is a tiny known-file wording edit. Make only that edit and verify the text.",
		assert: { forbiddenTools: ["subagents", "async_subagents_spawn"], maxFilesChanged: 1 },
	},
	{
		id: "orchestration.explicit-implementation",
		category: "orchestration",
		description: "Explicit user delegation uses the remaining implementation role.",
		fixture: "demo",
		blockTools: ["subagents"],
		prompt: "I explicitly want you to delegate this implementation: update the checkout API docs for the settled rule that retries reuse the original payment idempotency key, with one example, and check that the docs consistently describe that rule. Launch one appropriate implementation helper now, then stop after spawning. No parent investigation or waiting.",
		assert: { requiredTools: ["subagents"], maxFilesChanged: 0 },
		validate: (result: EvalRunResult) => validateDelegationRole(result, "implement-core"),
	},
	{
		id: "orchestration.architecture-advice-first",
		category: "orchestration",
		description: "Uncertain architecture calls for bounded advice, not implementation takeover.",
		fixture: "demo",
		blockTools: ["subagents"],
		prompt: "I need a strong independent second opinion on the cross-module invariant for payment retries: whether an idempotency key belongs to the original payment or each attempt, and its persistence/recovery implications. Delegate one bounded read-only architectural opinion now and stop after spawning; do not delegate any implementation.",
		assert: { requiredTools: ["subagents"], maxFilesChanged: 0 },
		validate: validateOracleBudget,
	},
	{
		id: "orchestration.large-mechanical",
		category: "orchestration",
		description: "Large specified transformations can use mechanical with a deterministic acceptance check.",
		fixture: "demo",
		blockTools: ["subagents"],
		prompt: "Delegate one helper for this settled batch transformation: in the 100 documentation files listed in the assigned scope docs/generated/, replace the exact literal `npm install` with `npm ci` and nothing else. Acceptance is an exact diff check that every change is that replacement; no semantics or tests may change. The batch is large enough to amortize briefing and verification. Launch the helper now and stop after spawning; no parent inspection.",
		assert: { requiredTools: ["subagents"], maxFilesChanged: 0 },
		validate: (result: EvalRunResult) => validateDelegationRole(result, "mechanical"),
	},
];

export const DELEGATION_POLICY_CASES: EvalCase[] = delegationPolicyCases.map((scenario) => ({
	...scenario,
	appendSystemPrompt: SUBAGENT_DELEGATION_GUIDANCE,
}));
