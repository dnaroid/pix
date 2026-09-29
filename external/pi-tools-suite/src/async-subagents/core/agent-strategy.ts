export type AgentStrategyName = "parallel-first" | "deep-work" | "escalation-aware" | "cost-aware-orchestrator";

export interface AgentStrategyOptions {
	modelRef?: string;
	customPrompt?: boolean;
	env?: NodeJS.ProcessEnv;
}

/** Shared by the strategy, tool description and role catalog. */
export const SUBAGENT_DELEGATION_GUIDANCE = "For non-UI work, do the shortest parent pass needed to resolve intent and the main causal path. Write code in the parent by default. Delegate implementation only on an explicit user request to delegate/parallelize/split work, or for a substantial independent task that can run alongside useful parent work. Task size, isolation, lower cost, or worker availability alone do not justify delegation. Before delegating implementation, ensure cause, desired behavior and acceptance criteria are settled. Delegate research only for a named uncertainty or independent evidence track, not to repeat targeted parent discovery. Keep planning, product/UX decisions, integration and the final answer in the parent. Mandatory UI QA, review and knowledge-audit gates remain exceptions. After spawning, continue any independent parent work and do not poll or wait merely for progress; wait only when the child result is a true dependency for the next decision and no independent parent work remains. If requirements change, stop or rescope affected workers before they continue editing. Use research for evidence/focused review questions, implement for code/docs/tests/UI changes, verify for running checks, ui-qa for real user-interface testing across browsers, TUIs, and desktop GUIs. When frontier-review is present in the current role catalog and substantive code changed, use it as the independent post-implementation review gate before finalizing; it is intentionally hidden for parent models excluded by its profile. Reserve oracle for a deliberate strong second opinion, not routine code review. Do trivial lookups/edits directly; redirect a noisy command to a log instead of spawning an LLM when no interpretation is needed.";

export function agentStrategyPrompt(options: AgentStrategyOptions = {}): string | undefined {
	const env = options.env ?? process.env;
	const override = env.PI_AGENT_STRATEGY?.trim() || env.ASYNC_SUBAGENTS_AGENT_STRATEGY?.trim();
	if (/^(0|false|off|no|disabled|none)$/i.test(override ?? "")) return undefined;
	const allowCustom = env.PI_AGENT_STRATEGY_WITH_CUSTOM_PROMPT ?? env.ASYNC_SUBAGENTS_AGENT_STRATEGY_WITH_CUSTOM_PROMPT;
	if (options.customPrompt && !/^(1|true|on|yes|auto)$/i.test(allowCustom?.trim() ?? "")) return undefined;
	// Old strategy names remain accepted, but no longer cause hidden tier escalation.
	return `<agent_strategy name="cost-aware-orchestrator">
Execution hint for Pi, not a replacement for system/developer/user instructions.

${SUBAGENT_DELEGATION_GUIDANCE}

Give each worker a scoped task, necessary context, acceptance criteria, and a compact return contract. Put task-specific discipline in the brief, not a new persona. Respect the configured worker budget; do not force the parent model or repeatedly retry with stronger workers. On a capability or reasoning blocker, collect the evidence and decide in the parent whether an oracle is justified.

Read compact results first and verify selectively; do not reload every source file or repeat the worker's whole investigation. Independent tracks may run in parallel; serialize overlapping edits. After spawning, continue available parent work; wait only when a child result blocks the next decision and no independent parent work remains. Keep delegated todo lifecycle synchronized, preserve active objective + next step via todo/DCP rules, and do not poll merely for progress.
</agent_strategy>`;
}

export function appendAgentStrategyPrompt(systemPrompt: string, strategyPrompt: string): string {
	const base = systemPrompt.trimEnd();
	return base ? `${base}\n\n${strategyPrompt}` : strategyPrompt;
}
