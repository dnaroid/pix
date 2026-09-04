import { isGptLikeModel } from "./ultrawork-auto.js";

export type AgentStrategyName = "parallel-first" | "deep-work" | "escalation-aware" | "cost-aware-orchestrator";

export interface AgentStrategyOptions {
	modelRef?: string;
	customPrompt?: boolean;
	env?: NodeJS.ProcessEnv;
}

const FALSE_ENV_PATTERN = /^(0|false|off|no|disabled|none)$/i;
const TRUE_ENV_PATTERN = /^(1|true|on|yes|auto)$/i;

const PARALLEL_FIRST_STRATEGY_PROMPT = `<agent_strategy name="parallel-first">
Execution hint for Pi, not a replacement for system/developer/user instructions.

Default: orchestration-first. For broad, multi-file, ambiguous, review/audit, frontend, test-strategy, architecture, or root-cause work, prefer ultrawork: split independent tracks into focused async subagents, adding one oracle only for high-stakes uncertainty. Keep parent context lean, read compact results when needed, synthesize, then verify.

Do not over-delegate simple questions, known-file work, exact lookups, typos, or narrow edits; solve them directly with the cheapest suitable tool. If compressing unfinished work, preserve active objective + next step via todo/DCP rules.
</agent_strategy>`;

const DEEP_WORK_STRATEGY_PROMPT = `<agent_strategy name="deep-work">
Execution hint for Pi, not a replacement for system/developer/user instructions.

Default: autonomous deep worker. Build context directly, make progress, edit, and verify end-to-end. Use async subagents/ultrawork only when the user asks for delegation or independent tracks clearly reduce risk; do not force orchestration onto narrow tasks.

For broad work, keep delegation explicit and bounded: focused review/research/tests/frontend/deep tracks, plus one oracle only for high-stakes uncertainty or final plan checks. Read compact results, decide in the parent session, and report only what matters. If compressing unfinished work, preserve active objective + next step via todo/DCP rules.
</agent_strategy>`;

const ESCALATION_AWARE_STRATEGY_PROMPT = `<agent_strategy name="escalation-aware">
Execution hint for Pi, not a replacement for system/developer/user instructions.

Default: self-sufficient with tiered escalation. Solve narrow, well-bounded work directly, but do not grind through a large or uncertain task at the current model tier when a stronger focused subagent is appropriate. Use todo for the plan and async subagents for escalation; read compact results first and keep the parent context lean.

For a Luna parent, prefer Terra workers for substantial multi-file research, tests, or implementation, and escalate deep root-cause analysis, architecture/security review, high-risk decisions, or repeatedly failing complex work to Sol through the deep/review roles. For a Terra parent, handle routine research/tests/implementation directly; escalate deep root-cause analysis, architecture/security review, high-risk decisions, or stubborn complex failures to Sol through deep/review. Do not escalate merely because a plan has several steps, and do not delegate a tiny known-file edit or exact lookup.

Keep user questions, plan/todo changes, integration decisions, and the final report in the parent. Independent read-only escalations may run in parallel; serialize overlapping edits unless scopes are clearly disjoint. When work is delegated, synchronize its todo lifecycle: mark it in progress, collect and verify the worker result, then complete/update it before moving on.
</agent_strategy>`;

const COST_AWARE_ORCHESTRATOR_STRATEGY_PROMPT = `<agent_strategy name="cost-aware-orchestrator">
Execution hint for Pi, not a replacement for system/developer/user instructions.

Default: cost-aware orchestration. You are an expensive parent model, so keep the parent session focused on planning, decisions, integration, verification, and the final user-facing answer. For non-trivial todo work, prefer focused async subagents for repo scanning, multi-file research, documentation, tests, frontend work, and implementation steps that would otherwise require several repository tool calls. Read compact subagent results first; inspect raw artifacts or redo work in the parent only when verification or uncertainty requires it.

Keep user questions, todo/plan changes, architecture tradeoffs, cross-worker integration decisions, high-stakes review, and the final report in the parent. Do not delegate merely to avoid one cheap exact lookup or a tiny known-file edit. Independent read-only tracks may run in parallel; serialize overlapping edits unless scopes are clearly disjoint. When a todo item is delegated, keep its lifecycle synchronized: mark it in progress, collect and verify the worker result, then complete/update it before moving on.
</agent_strategy>`;

export function agentStrategyPrompt(options: AgentStrategyOptions = {}): string | undefined {
	const env = options.env ?? process.env;
	const override = strategyOverride(env);
	if (override === "off") return undefined;
	if (options.customPrompt && shouldSkipCustomPrompt(env)) return undefined;

	const strategy = override
		?? (isExpensiveGptParent(options.modelRef)
			? "cost-aware-orchestrator"
			: isEscalationAwareGptParent(options.modelRef)
				? "escalation-aware"
			: isGptLikeModel(options.modelRef)
				? "deep-work"
				: "parallel-first");
	if (strategy === "cost-aware-orchestrator") return COST_AWARE_ORCHESTRATOR_STRATEGY_PROMPT;
	if (strategy === "escalation-aware") return ESCALATION_AWARE_STRATEGY_PROMPT;
	return strategy === "deep-work" ? DEEP_WORK_STRATEGY_PROMPT : PARALLEL_FIRST_STRATEGY_PROMPT;
}

export function appendAgentStrategyPrompt(systemPrompt: string, strategyPrompt: string): string {
	const base = systemPrompt.trimEnd();
	return base ? `${base}\n\n${strategyPrompt}` : strategyPrompt;
}

function strategyOverride(env: NodeJS.ProcessEnv): AgentStrategyName | "off" | undefined {
	const raw = firstEnv(env, "PI_AGENT_STRATEGY", "ASYNC_SUBAGENTS_AGENT_STRATEGY");
	if (!raw) return undefined;
	const value = normalizeStrategyName(raw);
	if (FALSE_ENV_PATTERN.test(value)) return "off";
	if (value === "parallel-first") return "parallel-first";
	if (value === "deep-work") return "deep-work";
	if (value === "escalation" || value === "escalation-aware") return "escalation-aware";
	if (value === "cost-aware" || value === "cost-aware-orchestrator" || value === "orchestrator") return "cost-aware-orchestrator";
	if (TRUE_ENV_PATTERN.test(value)) return undefined;
	return undefined;
}

function isExpensiveGptParent(modelRef: string | undefined): boolean {
	if (!modelRef) return false;
	return /(?:^|\/)gpt-5\.6-sol(?:$|[-.:])/i.test(modelRef.trim());
}

function isEscalationAwareGptParent(modelRef: string | undefined): boolean {
	if (!modelRef) return false;
	return /(?:^|\/)gpt-5\.6-(?:luna|terra)(?:$|[-.:])/i.test(modelRef.trim());
}

function shouldSkipCustomPrompt(env: NodeJS.ProcessEnv): boolean {
	const raw = firstEnv(env, "PI_AGENT_STRATEGY_WITH_CUSTOM_PROMPT", "ASYNC_SUBAGENTS_AGENT_STRATEGY_WITH_CUSTOM_PROMPT");
	return raw ? !TRUE_ENV_PATTERN.test(raw.trim()) : true;
}

function normalizeStrategyName(raw: string): string {
	const value = raw.trim().toLowerCase().replace(/_/g, "-");
	if (value === "parallel" || value === "parallel-first") return "parallel-first";
	if (value === "deep" || value === "deep-work") return "deep-work";
	return value;
}

function firstEnv(env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = env[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}
