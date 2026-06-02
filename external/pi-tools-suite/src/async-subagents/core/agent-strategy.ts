import { isGptLikeModel } from "./ultrawork-auto.js";

export type AgentStrategyName = "parallel-first" | "deep-work";

export interface AgentStrategyOptions {
	modelRef?: string;
	customPrompt?: boolean;
	env?: NodeJS.ProcessEnv;
}

const FALSE_ENV_PATTERN = /^(0|false|off|no|disabled|none)$/i;
const TRUE_ENV_PATTERN = /^(1|true|on|yes|auto)$/i;

const PARALLEL_FIRST_STRATEGY_PROMPT = `<agent_strategy name="parallel-first">
This is an orchestration hint for Pi, not a replacement for the user's instructions.

Default posture: orchestration-first for non-GPT models. For broad, multi-file, ambiguous, review/audit, frontend, test-strategy, architecture, or root-cause work, prefer ultrawork mode: split independent tracks and spawn focused async subagents with the configured roles. Keep the parent context lean, collect compact results only when needed, synthesize the findings, then verify before finishing.

Before DCP/compress while work is unfinished, keep one in_progress todo with objective + next step; compression summaries must preserve Active objective and Next step.

Do not over-delegate trivial work. For a simple question, one known file, exact lookup, typo, or narrow edit, solve directly with the cheapest suitable tool.
</agent_strategy>`;

const DEEP_WORK_STRATEGY_PROMPT = `<agent_strategy name="deep-work">
This is a GPT-compatible execution hint for Pi, not a replacement for the user's instructions.

Default posture: autonomous deep worker. Build context directly, make concrete progress, edit and verify end-to-end. Use async subagents and ultrawork mode when the user asks for parallel/delegated work or when independent tracks will clearly reduce risk, but do not force orchestration onto narrow tasks.

Before DCP/compress while work is unfinished, keep one in_progress todo with objective + next step; compression summaries must preserve Active objective and Next step.

For broad work, keep delegation explicit and bounded: spawn focused review/research/tests/frontend/deep tracks, read compact results, make the final decisions in the parent session, and report only what matters.
</agent_strategy>`;

export function agentStrategyPrompt(options: AgentStrategyOptions = {}): string | undefined {
	const env = options.env ?? process.env;
	const override = strategyOverride(env);
	if (override === "off") return undefined;
	if (options.customPrompt && shouldSkipCustomPrompt(env)) return undefined;

	const strategy = override ?? (isGptLikeModel(options.modelRef) ? "deep-work" : "parallel-first");
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
	if (TRUE_ENV_PATTERN.test(value)) return undefined;
	return undefined;
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
