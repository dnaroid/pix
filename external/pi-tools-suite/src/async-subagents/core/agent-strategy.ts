export type AgentStrategyName = "parallel-first" | "deep-work" | "escalation-aware" | "cost-aware-orchestrator";

export interface AgentStrategyOptions {
	modelRef?: string;
	customPrompt?: boolean;
	env?: NodeJS.ProcessEnv;
}

/** Canonical delegation policy, emitted once in the subagents tool description. */
export const SUBAGENT_DELEGATION_GUIDANCE = "For non-UI work, do the shortest parent pass needed to resolve intent and the main causal path. Write code in the parent by default. Delegate implementation only on an explicit user request to delegate/parallelize/split work, a concrete capability gap that the implementation itself requires a stronger worker to close, or sufficiently large prescribed mechanical work with deterministic checks and an expected net saving. Task size, parallelism, isolation, token price, or worker availability alone do not justify delegation. For difficult architecture, seek a bounded read-only oracle opinion first when needed, then implement in the parent unless the implementation itself still exceeds the parent's capabilities. Before delegating implementation, ensure cause, desired behavior and acceptance criteria are settled. Delegate research only for a named uncertainty or independent evidence track, not to repeat targeted parent discovery. Keep planning, product/UX decisions, integration and the final answer in the parent. Mandatory UI QA, architectural review and final documentation maintenance remain exceptions. After spawning, continue any independent parent work and do not poll or wait merely for progress; wait only when the child result is a true dependency for the next decision and no independent parent work remains. If requirements change, stop or rescope affected workers before they continue editing. Use research for evidence/focused review questions, verify for running checks that need interpretation, and ui-qa for real user-interface testing across browsers, TUIs, and desktop GUIs. When oracle is present in the current role catalog and a complex architectural task changed code, use it as the independent post-implementation review gate before finalizing. Routine features, local bug fixes, mechanical edits, and large diffs alone do not require oracle; role availability alone is not a trigger. Complex architectural tasks involve consequential subsystem boundaries, core interfaces, or cross-module lifecycle/persistence invariants. Oracle also provides a deliberate strong second opinion for hard or high-stakes uncertainty; do not use it for routine code review or automatic worker escalation. Do trivial lookups/edits directly; redirect a noisy command to a log instead of spawning an LLM when no interpretation is needed."
	+ " Use implement-core for an approved capability-driven or explicitly requested implementation handoff, and mechanical only for prescribed behavior-preserving transformations large enough to justify handoff overhead, not a few replacements. Honor the effective project catalog and choose the role rather than overriding its model. Do not route broad migrations or semantic test changes to mechanical. Break migrations into coherent slices with an early affected typecheck and focused regression before broadening the diff; an incomplete or timed-out slice is not accepted work. Stop and rescope based on that evidence, not merely a timeout or an automatic stronger-model retry. Compare cost per accepted verified change, including failed attempts, review and rework, duplicated context, briefing and integration, not just token price. Parallel execution can reduce latency without reducing total cost; model tier or a successful review alone does not prove an implementation capability advantage."
	+ " For oracle, omit spawn-level and task-level timeoutSeconds unless the user explicitly requests a shorter budget; retain the configured watchdog (30 minutes by default). Bound scope instead: one question/invariant, exact task diff/paths and exclusions, not a repository-wide audit. A watchdog timeout means incomplete work, not proof of a provider stall; do not switch models automatically."
	+ " Write sub-agent briefs in English to save tokens. Preserve exact literals and required user-facing text; reply to the user in their language.";

export function agentStrategyPrompt(options: AgentStrategyOptions = {}): string | undefined {
	const env = options.env ?? process.env;
	const override = env.PI_AGENT_STRATEGY?.trim() || env.ASYNC_SUBAGENTS_AGENT_STRATEGY?.trim();
	if (/^(0|false|off|no|disabled|none)$/i.test(override ?? "")) return undefined;
	const allowCustom = env.PI_AGENT_STRATEGY_WITH_CUSTOM_PROMPT ?? env.ASYNC_SUBAGENTS_AGENT_STRATEGY_WITH_CUSTOM_PROMPT;
	if (options.customPrompt && !/^(1|true|on|yes|auto)$/i.test(allowCustom?.trim() ?? "")) return undefined;
	// Old strategy names remain accepted, but no longer cause hidden tier escalation.
	return `<agent_strategy name="cost-aware-orchestrator">
Worker briefing and integration guidance. Delegation triggers and mandatory gates are defined in the subagents tool description, not repeated here.

Give each worker a scoped task, necessary context, acceptance criteria, and a compact return contract. Put task-specific discipline in the brief, not a new persona. Respect the configured worker budget; do not force the parent model or repeatedly retry with stronger workers. On a capability or reasoning blocker, collect the evidence and decide in the parent whether an oracle is justified.

Read compact results first and verify selectively; do not reload every source file or repeat the worker's whole investigation. Independent tracks may run in parallel; serialize overlapping edits. After spawning, continue available parent work; wait only when a child result blocks the next decision and no independent parent work remains. Keep delegated todo lifecycle synchronized, preserve active objective + next step via todo/DCP rules, and do not poll merely for progress.
</agent_strategy>`;
}

export function appendAgentStrategyPrompt(systemPrompt: string, strategyPrompt: string): string {
	const base = systemPrompt.trimEnd();
	return base ? `${base}\n\n${strategyPrompt}` : strategyPrompt;
}
