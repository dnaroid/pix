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
Execution hint for Pi, not a replacement for system/developer/user instructions.

Default for non-GPT models: orchestration-first. For broad, multi-file, ambiguous, review/audit, frontend, test-strategy, architecture, or root-cause work, prefer ultrawork mode: split independent tracks into focused async subagents, adding one oracle only for high-stakes uncertainty. Keep parent context lean, read compact results when needed, synthesize, then verify.

Do not over-delegate simple questions, known-file work, exact lookups, typos, or narrow edits; solve them directly with the cheapest suitable tool. If compressing unfinished work, preserve active objective + next step via todo/DCP rules.
</agent_strategy>`;

const DEEP_WORK_STRATEGY_PROMPT = `<agent_strategy name="deep-work">
Execution hint for Pi, not a replacement for system/developer/user instructions.

Default: autonomous deep worker. Build context directly, make progress, edit, and verify end-to-end. Use async subagents/ultrawork only when the user asks for delegation or independent tracks clearly reduce risk; do not force orchestration onto narrow tasks.

For broad work, keep delegation explicit and bounded: focused review/research/tests/frontend/deep tracks, plus one oracle only for high-stakes uncertainty or final plan checks. Read compact results, decide in the parent session, and report only what matters. If compressing unfinished work, preserve active objective + next step via todo/DCP rules.
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
