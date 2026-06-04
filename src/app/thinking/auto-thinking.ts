import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS } from "../constants.js";
import type { SubmittedUserMessage, ThinkingLevel, ThinkingSelection } from "../types.js";

export const AUTO_THINKING_LEVEL = "auto" as const;

const THINKING_LEVEL_RANK: Record<ThinkingLevel, number> = {
	off: 0,
	minimal: 1,
	low: 2,
	medium: 3,
	high: 4,
	xhigh: 5,
};

export type AutoThinkingDecision = {
	level: ThinkingLevel;
	desiredLevel: ThinkingLevel;
	reason: string;
	availableLevels: ThinkingLevel[];
};

export type AutoThinkingPromptInput = {
	promptText: string;
	imageCount?: number;
	availableLevels?: readonly string[];
};

export type AutoThinkingPreparation = {
	decision: AutoThinkingDecision;
	restore(): void;
};

type AutoThinkingSessionState = {
	baselineLevel: ThinkingLevel;
	effectiveLevel?: ThinkingLevel;
	generation: number;
};

export class AutoThinkingController {
	private readonly states = new WeakMap<AgentSession, AutoThinkingSessionState>();

	isEnabled(session: AgentSession | undefined): boolean {
		return session ? this.states.has(session) : false;
	}

	enable(session: AgentSession): void {
		const current = this.states.get(session);
		this.states.set(session, {
			baselineLevel: current?.baselineLevel ?? normalizeThinkingLevel(session.thinkingLevel) ?? "off",
			...(current?.effectiveLevel === undefined ? {} : { effectiveLevel: current.effectiveLevel }),
			generation: (current?.generation ?? 0) + 1,
		});
	}

	disable(session: AgentSession, options: { restoreBaseline?: boolean } = {}): void {
		const state = this.states.get(session);
		if (!state) return;

		if (options.restoreBaseline !== false) {
			setTransientSessionThinkingLevel(session, state.baselineLevel);
		}
		this.states.delete(session);
	}

	label(session: AgentSession): string | undefined {
		const state = this.states.get(session);
		if (!state) return undefined;
		return state.effectiveLevel ? `${AUTO_THINKING_LEVEL}:${state.effectiveLevel}` : AUTO_THINKING_LEVEL;
	}

	prepareForPrompt(session: AgentSession, message: SubmittedUserMessage): AutoThinkingPreparation | undefined {
		const state = this.states.get(session);
		if (!state || session.isStreaming) return undefined;

		const baselineLevel = normalizeThinkingLevel(session.thinkingLevel) ?? state.baselineLevel;
		state.baselineLevel = baselineLevel;
		const generation = state.generation;
		const decision = chooseAutoThinkingLevel({
			promptText: message.promptText,
			imageCount: message.images.length,
			availableLevels: session.getAvailableThinkingLevels(),
		});
		state.effectiveLevel = decision.level;
		setTransientSessionThinkingLevel(session, decision.level);

		return {
			decision,
			restore: () => {
				const current = this.states.get(session);
				if (!current || current.generation !== generation) return;
				if (normalizeThinkingLevel(session.thinkingLevel) === decision.level) {
					setTransientSessionThinkingLevel(session, current.baselineLevel);
				}
			},
		};
	}
}

export function isThinkingSelection(value: string): value is ThinkingSelection {
	return value === AUTO_THINKING_LEVEL || normalizeThinkingLevel(value) !== undefined;
}

export function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
	return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel)
		? value as ThinkingLevel
		: undefined;
}

export function normalizeAvailableThinkingLevels(levels: readonly string[] | undefined): ThinkingLevel[] {
	const seen = new Set<ThinkingLevel>();
	const normalized: ThinkingLevel[] = [];
	for (const level of levels ?? THINKING_LEVELS) {
		const normalizedLevel = normalizeThinkingLevel(level);
		if (!normalizedLevel || seen.has(normalizedLevel)) continue;
		seen.add(normalizedLevel);
		normalized.push(normalizedLevel);
	}
	return normalized.length > 0 ? normalized : ["off"];
}

export function chooseAutoThinkingLevel(input: AutoThinkingPromptInput): AutoThinkingDecision {
	const availableLevels = normalizeAvailableThinkingLevels(input.availableLevels);
	if (availableLevels.length === 1 && availableLevels[0] === "off") {
		return {
			level: "off",
			desiredLevel: "off",
			reason: "model does not expose reasoning levels",
			availableLevels,
		};
	}

	const desiredLevel = desiredAutoThinkingLevel(input);
	const level = closestSupportedThinkingLevel(desiredLevel, availableLevels);
	return {
		level,
		desiredLevel,
		reason: autoThinkingReason(input, desiredLevel, level),
		availableLevels,
	};
}

export function closestSupportedThinkingLevel(desiredLevel: ThinkingLevel, availableLevels: readonly ThinkingLevel[]): ThinkingLevel {
	if (availableLevels.includes(desiredLevel)) return desiredLevel;
	if (desiredLevel === "off" && availableLevels.includes("off")) return "off";

	const desiredRank = THINKING_LEVEL_RANK[desiredLevel];
	const nonOffAtOrBelow = availableLevels
		.filter((level) => level !== "off" && THINKING_LEVEL_RANK[level] <= desiredRank)
		.sort((left, right) => THINKING_LEVEL_RANK[right] - THINKING_LEVEL_RANK[left])[0];
	if (nonOffAtOrBelow) return nonOffAtOrBelow;

	const nonOffAbove = availableLevels
		.filter((level) => level !== "off" && THINKING_LEVEL_RANK[level] > desiredRank)
		.sort((left, right) => THINKING_LEVEL_RANK[left] - THINKING_LEVEL_RANK[right])[0];
	if (nonOffAbove && desiredRank >= THINKING_LEVEL_RANK.medium) return nonOffAbove;

	return availableLevels.includes("off") ? "off" : availableLevels[0] ?? "off";
}

function desiredAutoThinkingLevel(input: AutoThinkingPromptInput): ThinkingLevel {
	const text = input.promptText.trim();
	const lower = text.toLowerCase();
	const imageCount = input.imageCount ?? 0;
	if (isAcknowledgement(lower) && imageCount === 0) return "off";
	if (imageCount > 0 || isHighComplexityPrompt(lower, text)) return "high";
	if (isLowComplexityPrompt(lower, text)) return "low";
	return "medium";
}

function isAcknowledgement(lower: string): boolean {
	return /^(ok|okay|yes|no|thanks|thank you|спасибо|ок|да|нет|понял|поняла|ясно)[.!?\s]*$/u.test(lower);
}

function isLowComplexityPrompt(lower: string, original: string): boolean {
	if (original.length > 220 || /```/u.test(original)) return false;
	return /\b(explain|what is|how do i|list|show|find)\b/u.test(lower)
		|| /\b(объясни|что такое|как|покажи|найди|список)\b/u.test(lower);
}

function isHighComplexityPrompt(lower: string, original: string): boolean {
	if (original.length > 800 || /```|stack trace|traceback|\berror\b|exception|failed|failing/u.test(lower)) return true;
	const complexMatches = lower.match(/\b(implement|add|fix|debug|refactor|architecture|design|investigate|migrate|test|coverage|release|risk|parallel|mvp)\b/gu)?.length ?? 0;
	const ruComplexMatches = lower.match(/\b(добав|исправ|почин|рефактор|архитект|дизайн|исслед|мигр|тест|покрыт|релиз|риск|паралл|mvp)\w*/gu)?.length ?? 0;
	const totalComplexMatches = complexMatches + ruComplexMatches;
	return totalComplexMatches >= 2 || (totalComplexMatches >= 1 && original.length > 80);
}

function autoThinkingReason(input: AutoThinkingPromptInput, desiredLevel: ThinkingLevel, level: ThinkingLevel): string {
	const suffix = desiredLevel === level ? "" : `; using nearest available ${level}`;
	if ((input.imageCount ?? 0) > 0) return `image prompt -> ${desiredLevel}${suffix}`;
	if (desiredLevel === "off") return `trivial acknowledgement -> ${desiredLevel}${suffix}`;
	if (desiredLevel === "low") return `short/simple prompt -> ${desiredLevel}${suffix}`;
	if (desiredLevel === "high") return `complex coding/debug prompt -> ${desiredLevel}${suffix}`;
	return `default coding baseline -> ${desiredLevel}${suffix}`;
}

function setTransientSessionThinkingLevel(session: AgentSession, level: ThinkingLevel): void {
	session.agent.state.thinkingLevel = level;
}
