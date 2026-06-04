import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS } from "../constants.js";
import type { SubmittedUserMessage, ThinkingLevel, ThinkingSelection } from "../types.js";

export const AUTO_THINKING_LEVEL = "auto" as const;
export const DEFAULT_AUTO_THINKING_BASELINE_LEVEL = "medium" as const satisfies ThinkingLevel;
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

export type AutoThinkingDecisionInput = {
	availableLevels?: readonly string[];
};

type AutoThinkingSessionState = {
	baselineLevel: ThinkingLevel;
	effectiveLevel?: ThinkingLevel;
};

export class AutoThinkingController {
	private readonly states = new WeakMap<AgentSession, AutoThinkingSessionState>();

	isEnabled(session: AgentSession | undefined): boolean {
		return session ? this.states.has(session) : false;
	}

	enable(session: AgentSession): void {
		const current = this.states.get(session);
		const currentLevel = normalizeThinkingLevel(session.thinkingLevel);
		const baselineLevel = current?.baselineLevel
			?? currentLevel
			?? defaultAutoThinkingLevelForSession(session);
		const effectiveLevel = current?.effectiveLevel;
		this.states.set(session, {
			baselineLevel,
			...(effectiveLevel === undefined ? {} : { effectiveLevel }),
		});
		setTransientSessionThinkingLevel(session, effectiveLevel ?? currentLevel ?? baselineLevel);
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
		_message: SubmittedUserMessage,
	): Promise<void> {
		const state = this.states.get(session);
		if (!state || session.isStreaming) return;

		const currentLevel = normalizeThinkingLevel(session.thinkingLevel);
		if (state.effectiveLevel) {
			if (currentLevel !== state.effectiveLevel) setTransientSessionThinkingLevel(session, state.effectiveLevel);
			return;
		}

		if (currentLevel) state.baselineLevel = currentLevel;
		else setTransientSessionThinkingLevel(session, state.baselineLevel);
	}

	applyAdaptiveRequest(session: AgentSession, request: AutoThinkingAdaptiveRequest): AutoThinkingDecision | undefined {
		const state = this.states.get(session);
		if (!state) return undefined;

		const decision = autoThinkingDecisionForDesiredLevel(
			{ availableLevels: session.getAvailableThinkingLevels() },
			request.thinking,
			autoThinkingAdaptiveReason(request),
		);
		const currentModeLevel = state.effectiveLevel ?? normalizeThinkingLevel(session.thinkingLevel) ?? state.baselineLevel;
		if (decision.level === currentModeLevel) return undefined;

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

export function autoThinkingDecisionForDesiredLevel(
	input: AutoThinkingDecisionInput,
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
	return `model-requested thinking level${suffix}`;
}

function autoThinkingAdaptiveReason(request: AutoThinkingAdaptiveRequest): string {
	const reasonCode = request.reasonCode
		.replace(/[\t\r\n]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, 80);
	const prefix = request.apply === "restart_current"
		? "adaptive restart requested; switching mode from next call"
		: "adaptive mode switch";
	return reasonCode ? `${prefix}: ${reasonCode}` : prefix;
}

function defaultAutoThinkingLevelForSession(session: AgentSession): ThinkingLevel {
	return closestSupportedThinkingLevel(
		DEFAULT_AUTO_THINKING_BASELINE_LEVEL,
		normalizeAvailableThinkingLevels(session.getAvailableThinkingLevels()),
	);
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
