import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS } from "../constants.js";
import type { SubmittedUserMessage, ThinkingLevel, ThinkingSelection } from "../types.js";

export const AUTO_THINKING_LEVEL = "auto" as const;
export const AUTO_THINKING_DECISION_PREFIX = "auto thinking: ";
export const AUTO_THINKING_SESSION_CUSTOM_TYPE = "pix:auto_thinking";

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

export type AutoThinkingAdaptiveApply = "next_call" | "restart_current";

export type AutoThinkingAdaptiveRequest = {
	thinking: ThinkingLevel;
	apply: AutoThinkingAdaptiveApply;
	reasonCode: string;
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

	async prepareForPrompt(
		session: AgentSession,
		message: SubmittedUserMessage,
	): Promise<AutoThinkingPreparation | undefined> {
		const state = this.states.get(session);
		if (!state || session.isStreaming) return undefined;

		const baselineLevel = normalizeThinkingLevel(session.thinkingLevel) ?? state.baselineLevel;
		state.baselineLevel = baselineLevel;
		const generation = state.generation;
		const input = {
			promptText: message.promptText,
			imageCount: message.images.length,
			availableLevels: session.getAvailableThinkingLevels(),
		} satisfies AutoThinkingPromptInput;
		const current = this.states.get(session);
		if (!current || current.generation !== generation || session.isStreaming) return undefined;

		const decision = chooseAutoThinkingLevel(input);
		current.effectiveLevel = decision.level;
		setTransientSessionThinkingLevel(session, decision.level);

		return {
			decision,
			restore: () => {
				const restoreState = this.states.get(session);
				if (!restoreState || restoreState.generation !== generation) return;
				setTransientSessionThinkingLevel(session, restoreState.baselineLevel);
			},
		};
	}

	applyAdaptiveRequest(session: AgentSession, request: AutoThinkingAdaptiveRequest): AutoThinkingDecision | undefined {
		const state = this.states.get(session);
		if (!state) return undefined;

		const decision = autoThinkingDecisionForDesiredLevel({
			promptText: "",
			availableLevels: session.getAvailableThinkingLevels(),
		}, request.thinking, autoThinkingAdaptiveReason(request));
		state.effectiveLevel = decision.level;
		setTransientSessionThinkingLevel(session, decision.level);
		return decision;
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
	return autoThinkingDecisionForDesiredLevel(input, "medium");
}

export function autoThinkingDecisionForDesiredLevel(
	input: AutoThinkingPromptInput,
	desiredLevel: ThinkingLevel,
	reason?: string,
): AutoThinkingDecision {
	const availableLevels = normalizeAvailableThinkingLevels(input.availableLevels);
	if (availableLevels.length === 1 && availableLevels[0] === "off") {
		return {
			level: "off",
			desiredLevel: "off",
			reason: "model does not expose reasoning levels",
			availableLevels,
		};
	}

	const level = closestSupportedThinkingLevel(desiredLevel, availableLevels);
	return {
		level,
		desiredLevel,
		reason: reason ? withNearestAvailableSuffix(reason, desiredLevel, level) : autoThinkingReason(desiredLevel, level),
		availableLevels,
	};
}

export function formatAutoThinkingDecision(decision: AutoThinkingDecision): string {
	return `${AUTO_THINKING_DECISION_PREFIX}${decision.level} · ${decision.reason}`;
}

export function isAutoThinkingDecisionText(text: string): boolean {
	return text.startsWith(AUTO_THINKING_DECISION_PREFIX);
}

export function appendAutoThinkingSessionState(session: AgentSession, enabled: boolean): void {
	session.sessionManager.appendCustomEntry(AUTO_THINKING_SESSION_CUSTOM_TYPE, { enabled });
}

export function resolveAutoThinkingSessionState(entries: readonly SessionEntry[]): boolean | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry || entry.type !== "custom" || entry.customType !== AUTO_THINKING_SESSION_CUSTOM_TYPE) continue;
		return isAutoThinkingSessionData(entry.data) ? entry.data.enabled : undefined;
	}
	return undefined;
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

function autoThinkingReason(desiredLevel: ThinkingLevel, level: ThinkingLevel): string {
	const suffix = nearestAvailableSuffix(desiredLevel, level);
	return `default medium baseline${suffix}`;
}

function autoThinkingAdaptiveReason(request: AutoThinkingAdaptiveRequest): string {
	const reasonCode = request.reasonCode
		.replace(/[\t\r\n]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, 80);
	const prefix = request.apply === "restart_current"
		? "adaptive restart requested; applying to next call"
		: "adaptive next call";
	return reasonCode ? `${prefix}: ${reasonCode}` : prefix;
}

function withNearestAvailableSuffix(reason: string, desiredLevel: ThinkingLevel, level: ThinkingLevel): string {
	return `${reason}${nearestAvailableSuffix(desiredLevel, level)}`;
}

function nearestAvailableSuffix(desiredLevel: ThinkingLevel, level: ThinkingLevel): string {
	return desiredLevel === level ? "" : `; nearest available to ${desiredLevel}`;
}

function isAutoThinkingSessionData(value: unknown): value is { enabled: boolean } {
	return typeof value === "object" && value !== null && "enabled" in value && typeof (value as { enabled?: unknown }).enabled === "boolean";
}

function setTransientSessionThinkingLevel(session: AgentSession, level: ThinkingLevel): void {
	session.agent.state.thinkingLevel = level;
}
