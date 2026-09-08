export type AgentStrategyName = "parallel-first" | "deep-work" | "escalation-aware" | "cost-aware-orchestrator";

export interface AgentStrategyOptions {
	modelRef?: string;
	customPrompt?: boolean;
	env?: NodeJS.ProcessEnv;
}

/** Shared by the strategy, tool description and role catalog. */
export const SUBAGENT_DELEGATION_GUIDANCE = "Delegate bounded work when a lower-cost worker can do it or noisy intermediate evidence should stay out of the parent context; one sequential task can qualify. Keep planning, decisions, integration and the final answer in the parent. Use research for evidence/focused review questions, implement for code/docs/tests/UI changes, verify for running checks, browser-qa for browser testing. When frontier-review is present in the current role catalog and substantive code changed, use it as the independent post-implementation review gate before finalizing; it is intentionally hidden for parent models excluded by its profile. Reserve oracle for a deliberate strong independent opinion, not routine code review. Do trivial lookups/edits directly; redirect a noisy command to a log instead of spawning an LLM when no interpretation is needed.";

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

Read compact results first and verify selectively; do not reload every source file or repeat the worker's whole investigation. Independent tracks may run in parallel; serialize overlapping edits. Keep delegated todo lifecycle synchronized, preserve active objective + next step via todo/DCP rules, and do not poll merely for progress.
</agent_strategy>`;
}

export function appendAgentStrategyPrompt(systemPrompt: string, strategyPrompt: string): string {
	const base = systemPrompt.trimEnd();
	return base ? `${base}\n\n${strategyPrompt}` : strategyPrompt;
}
